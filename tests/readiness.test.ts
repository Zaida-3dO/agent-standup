// Readiness — the operation and the route.
//
// The operation is tested against a fake transaction handle rather than a
// live database: what it has to get right is which query it runs and how it
// reads the counts back, and both are visible from the handle it was given.
// Its behaviour against a real Postgres is covered by the route's own error
// path and by the migration ledger existing in every migrated database the
// DB-gated suites run against.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readiness } from "@/lib/service/operations/readiness";
import type { ServiceContext } from "@/lib/service/context";

/**
 * A context whose database handle answers with the supplied rows.
 *
 * `$queryRawUnsafe` is called twice — once to probe the connection and once
 * for the ledger — so the fake records every query it was given, which is
 * what lets the assertions below check that the probe really happened
 * rather than only that a number came back.
 */
function contextWith(options: { readonly migrationRows?: unknown; readonly failOn?: string }): {
  ctx: ServiceContext;
  queries: string[];
} {
  const queries: string[] = [];
  const ctx = {
    db: {
      async $queryRawUnsafe(query: string) {
        queries.push(query);
        if (options.failOn !== undefined && query.includes(options.failOn)) {
          throw new Error("connection refused");
        }
        if (query.includes("_prisma_migrations")) {
          return options.migrationRows ?? [{ applied: 3n, pending: 0n }];
        }
        return [{ probe: 1 }];
      },
      async $executeRawUnsafe() {
        return 0;
      },
    },
    settings: { values: {}, revision: 0n },
    caller: {},
    operation: "readiness",
  } as unknown as ServiceContext;
  return { ctx, queries };
}

describe("the readiness operation", () => {
  it("probes the connection before reading the ledger", async () => {
    const { ctx, queries } = contextWith({});

    await readiness.handler(ctx, {});

    expect(queries[0]).toContain("SELECT 1");
    expect(queries[1]).toContain("_prisma_migrations");
  });

  it("probes with a query needing no table to exist", async () => {
    // A probe that read a real table would report a correctly-connected but
    // empty installation as unreachable.
    const { ctx, queries } = contextWith({});

    await readiness.handler(ctx, {});

    expect(queries[0]).not.toMatch(/FROM/i);
  });

  it("is ready when the database answers and no migration is mid-flight", async () => {
    const { ctx } = contextWith({ migrationRows: [{ applied: 12n, pending: 0n }] });

    const result = await readiness.handler(ctx, {});

    expect(result).toEqual({
      ready: true,
      database: true,
      migrationsApplied: 12,
      migrationsPending: 0,
    });
  });

  it("is NOT ready when a migration is applied but unfinished", async () => {
    // The deploy worth stopping: connected, but the schema matches no
    // migration in the ledger completely.
    const { ctx } = contextWith({ migrationRows: [{ applied: 10n, pending: 2n }] });

    const result = await readiness.handler(ctx, {});

    expect(result.ready).toBe(false);
    expect(result.migrationsPending).toBe(2);
    // Still connected — the two facts are reported separately.
    expect(result.database).toBe(true);
  });

  it("converts bigint counts to numbers so the answer can be serialised", async () => {
    const { ctx } = contextWith({ migrationRows: [{ applied: 7n, pending: 0n }] });

    const result = await readiness.handler(ctx, {});

    expect(typeof result.migrationsApplied).toBe("number");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("reads a fresh database with no migrations as zero, not as a failure", async () => {
    const { ctx } = contextWith({ migrationRows: [{ applied: 0n, pending: 0n }] });

    const result = await readiness.handler(ctx, {});

    expect(result.migrationsApplied).toBe(0);
    expect(result.ready).toBe(true);
  });

  it("tolerates an empty ledger result rather than throwing", async () => {
    const { ctx } = contextWith({ migrationRows: [] });

    const result = await readiness.handler(ctx, {});

    expect(result.migrationsApplied).toBe(0);
    expect(result.migrationsPending).toBe(0);
  });

  it("tolerates null counts", async () => {
    const { ctx } = contextWith({ migrationRows: [{ applied: null, pending: null }] });

    const result = await readiness.handler(ctx, {});

    expect(result.migrationsApplied).toBe(0);
  });

  it("propagates an unreachable database rather than reporting a healthy false", async () => {
    // Inventing a successful response describing a failure would make an
    // unreachable database indistinguishable from a reachable one.
    const { ctx } = contextWith({ failOn: "SELECT 1" });

    await expect(readiness.handler(ctx, {})).rejects.toThrow();
  });

  it("is registered as a read", () => {
    expect(readiness.name).toBe("readiness");
    expect(readiness.kind).toBe("read");
  });
});

const serviceCall = vi.fn();
vi.mock("@/lib/service/live", () => ({
  service: { call: (...args: unknown[]) => serviceCall(...args) },
}));

describe("GET /api/ready", () => {
  beforeEach(() => {
    serviceCall.mockReset();
  });

  it("answers 200 when the installation is ready", async () => {
    serviceCall.mockResolvedValue({
      ready: true,
      database: true,
      migrationsApplied: 5,
      migrationsPending: 0,
    });
    const { GET } = await import("@/app/api/ready/route");

    const response = await GET(new Request("http://localhost/api/ready"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: true, migrationsApplied: 5 });
  });

  it("answers 503 when a migration is mid-flight, even though the database answered", async () => {
    // The status is what a probe acts on; most never parse the body.
    serviceCall.mockResolvedValue({
      ready: false,
      database: true,
      migrationsApplied: 5,
      migrationsPending: 1,
    });
    const { GET } = await import("@/app/api/ready/route");

    const response = await GET(new Request("http://localhost/api/ready"));

    expect(response.status).toBe(503);
  });

  it("answers 503 with the same body shape when the database is unreachable", async () => {
    serviceCall.mockRejectedValue(new Error("connection refused"));
    const { GET } = await import("@/app/api/ready/route");

    const response = await GET(new Request("http://localhost/api/ready"));
    const body = await response.json();

    expect(response.status).toBe(503);
    // A probe should not have to parse two different bodies to learn one fact.
    expect(body).toEqual({
      ready: false,
      database: false,
      migrationsApplied: 0,
      migrationsPending: 0,
    });
  });

  it("does not leak the underlying error to an unauthenticated caller", async () => {
    serviceCall.mockRejectedValue(new Error("connect ECONNREFUSED db-host:5432"));
    const { GET } = await import("@/app/api/ready/route");

    const body = await (await GET(new Request("http://localhost/api/ready"))).json();

    expect(JSON.stringify(body)).not.toContain("db-host");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("is a different route from liveness, which keeps answering 200", async () => {
    // The whole point of the row: one of the two consumers would otherwise
    // be silently given the other's answer.
    serviceCall.mockRejectedValue(new Error("connection refused"));
    const ready = await import("@/app/api/ready/route");
    const health = await import("@/app/api/health/route");

    const readyResponse = await ready.GET(new Request("http://localhost/api/ready"));
    const healthResponse = await health.GET();

    expect(readyResponse.status).toBe(503);
    expect(healthResponse.status).toBe(200);
  });
});
