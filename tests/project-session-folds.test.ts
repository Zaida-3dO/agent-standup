// The `project` and `session` folds, against Postgres.
//
// **What would make this file hollow.** Asserting that `project { action:
// "list" }` returns an array proves only that a dispatch happened. It would
// pass against a fold that sent `apply: false` on every repair, mapped `id`
// to the wrong delegate field, or refused nothing by name. So every case
// below fixes a decision and names what breaks it.
//
// The two decisions most worth pinning:
//
//   1. **`apply` is forwarded as it arrived, never defaulted here.**
//      `repair_stuck_projects` treats an absent `apply` as a dry run. A fold
//      that sent `apply: false` explicitly is indistinguishable by
//      behaviour, but restates a rule it does not own, so the two can drift.
//      A fold that sent `apply: true` would silently start writing.
//   2. **`id` reaches `repair_stuck_projects` as `projectId`.** The tool
//      calls the subject `id` for every action; that operation calls it
//      `projectId`. The mapping happens in the fold, and getting it wrong is
//      a refusal the caller cannot act on.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { listOperations } from "@/lib/service/registry";
import { exposedOperations } from "@/lib/adapters/waivers";
import { FOLDED_INTO } from "@/lib/service/describe/reachability";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  fields?: string[];
  message: string;
}

async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

// ── The surface, which needs no database ─────────────────────────────────

describe("the project and session folds' reachability", () => {
  const all = listOperations();

  const FOLDS: readonly (readonly [string, readonly string[]])[] = [
    ["project", ["get_projects", "get_project_detail", "repair_stuck_projects"]],
    ["session", ["register_session", "get_session_shape"]],
  ];

  it.each(FOLDS)("exposes `%s` on both MCP transports", (tool) => {
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      expect(names, `${tool} must be reachable from ${adapter}`).toContain(tool);
    }
  });

  it.each(FOLDS)("waives everything `%s` folds off both MCP transports", (tool, folded) => {
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      for (const operation of folded) {
        expect(names, `${operation} should be folded away on ${adapter}`).not.toContain(operation);
      }
    }
  });

  it.each(FOLDS)("keeps everything `%s` folds on HTTP and the command line", (_tool, folded) => {
    // The fold is an MCP-surface change only. An operation that fell off
    // every adapter would be stranded — asserted globally elsewhere, and
    // named here so a waiver on the wrong adapter fails with a clear name.
    for (const adapter of ["http", "cli"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      for (const operation of folded) {
        expect(names, `${operation} must stay on ${adapter}`).toContain(operation);
      }
    }
  });

  it.each(FOLDS)("records each verb's fold target, so advice can name `%s`", (tool, folded) => {
    for (const operation of folded) {
      expect(FOLDED_INTO.get(operation), `${operation} should record its fold`).toBe(tool);
    }
  });
});

describeIfDb("the project and session folds, against Postgres", () => {
  const dbName = scratchDatabaseName("project_session_folds");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = createTestPrismaClient(scratch.url);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
    await prisma.session.deleteMany({});
  });

  // `register_session` refuses a call whose transport the adapter did not
  // stamp — the capability signal is the adapter's to supply and never the
  // caller's — so every call here carries one, as a real adapter would.
  const call = <T>(name: string, input: unknown): Promise<T> =>
    runtime.call(name as never, input, {
      caller: { actor: "tester", transport: "mcp-http" },
    } as never) as Promise<T>;

  let counter = 0;
  async function seedProject(): Promise<string> {
    counter += 1;
    const id = `fold-project-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "project",
        title: `Project ${counter}`,
        body: "seeded for the fold tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  describe("project — each action reaches the operation it folds", () => {
    it("`list` reads the projects, the same as get_projects", async () => {
      await seedProject();
      const folded = await call("project", { action: "list" });
      const direct = await call("get_projects", {});
      expect(folded).toEqual(direct);
    });

    it("`detail` reads one project, the same as get_project_detail", async () => {
      const id = await seedProject();
      const folded = await call("project", { action: "detail", id });
      const direct = await call("get_project_detail", { id });
      expect(folded).toEqual(direct);
    });

    it("`repair` maps `id` onto the delegate's `projectId`", async () => {
      const id = await seedProject();
      // A wrong mapping refuses with "projectId is required" — a message the
      // caller cannot act on, because it names a field this tool has no way
      // to accept. Succeeding is the assertion.
      const folded = await call("project", { action: "repair", id });
      const direct = await call("repair_stuck_projects", { projectId: id });
      expect(folded).toEqual(direct);
    });
  });

  describe("project — `apply` decides whether repair writes", () => {
    it("writes nothing when `apply` is not mentioned", async () => {
      const id = await seedProject();
      const result = await call<{ applied?: boolean }>("project", { action: "repair", id });
      // The operation's own default is what makes this a dry run. If the
      // fold sent `apply: true`, this reports an applied repair. Sending
      // `apply: false` explicitly is indistinguishable by behaviour, but
      // restates a rule the fold does not own.
      expect(result.applied).not.toBe(true);
    });

    it("passes `apply` through when it is given", async () => {
      const id = await seedProject();
      const folded = await call("project", { action: "repair", id, apply: true });
      const direct = await call("repair_stuck_projects", { projectId: id, apply: true });
      expect(folded).toEqual(direct);
    });
  });

  describe("session — each action reaches the operation it folds", () => {
    it("`register` registers the session and answers with mayClaim", async () => {
      const result = await call<{ mayClaim?: unknown }>("session", {
        action: "register",
        sessionId: "sess-fold-1",
        machine: "calliope",
      });
      // `mayClaim` is resolved inside `register_session` against the
      // hook.require_registration_to_claim setting. A fold that recomputed
      // it would answer differently from the operation it claims to
      // reproduce.
      expect(result.mayClaim).toBeDefined();

      const rows = await prisma.session.findMany({ where: { id: "sess-fold-1" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.machine).toBe("calliope");
    });

    it("keeps the optional registration fields rather than dropping them", async () => {
      // `client` is optional, so losing it refuses nothing — the write
      // succeeds and is answered with a success. Reading the row back is the
      // only assertion that can tell "kept" from "accepted and discarded".
      await call("session", {
        action: "register",
        sessionId: "sess-fold-2",
        machine: "calliope",
        client: "claude-code",
      });
      const row = await prisma.session.findUnique({ where: { id: "sess-fold-2" } });
      expect(row?.client).toBe("claude-code");
    });

    it("`shape` reads a named session, the same as get_session_shape", async () => {
      await call("session", {
        action: "register",
        sessionId: "sess-fold-3",
        machine: "calliope",
      });
      const folded = await call("session", { action: "shape", sessionId: "sess-fold-3" });
      const direct = await call("get_session_shape", { sessionId: "sess-fold-3" });
      expect(folded).toEqual(direct);
    });
  });

  describe("a missing required field is refused by name, per action", () => {
    it("names `id` when project detail is called without one", async () => {
      const error = await rejection(call("project", { action: "detail" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("id");
      // The action is named too: `id` is required by two of three actions,
      // so "id is required" alone would not say which call went wrong.
      expect(error.message).toContain("detail");
    });

    it("names both `sessionId` and `machine` for a registration with neither", async () => {
      const error = await rejection(call("session", { action: "register" }));
      expect(error.fields).toEqual(expect.arrayContaining(["sessionId", "machine"]));
    });

    it("names `sessionId` alone for a shape read, which needs no machine", async () => {
      const error = await rejection(call("session", { action: "shape" }));
      expect(error.fields).toContain("sessionId");
      expect(error.fields).not.toContain("machine");
    });

    it("refuses a field no action declares, rather than ignoring it", async () => {
      const error = await rejection(call("project", { action: "list", nonsense: 1 }));
      expect(error.code).toBe("invalid_input");
    });
  });
});
