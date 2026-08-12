// `runInitSequence` (scripts/lib/run-init.mjs) — the sequencing behind
// MILESTONES.md #80's "prove it with a live round trip", with every real
// I/O dependency mocked so this proves the *ordering and routing* of
// connection strings deterministically, in milliseconds, with no database.
// The DB-gated tests (tests/run-init-sequence-db.test.ts) prove the same
// module actually works against real Postgres; this file proves it wires
// the right value to the right step, which is the part a real database
// can't tell apart from a bug that happens to still work once.
//
// The property under test in most of these: **the provisioning connection
// and the application connection are never the same value once a role was
// created**, and migrations always run against the provisioning connection
// while seed and the round-trip proof always run against the application
// one. A mutant that swapped `migrateUrl`/`appUrl` at either call site would
// still make `run-init.mjs` "work" against a single-role dev database (both
// URLs point at the same server either way) — it only shows up once the two
// URLs genuinely differ, which is exactly what these mocks force.
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function fakeChild(exitCode: number) {
  return {
    on(event: string, cb: (code: number) => void) {
      if (event === "exit") queueMicrotask(() => cb(exitCode));
      return this;
    },
  };
}

interface Mocks {
  migrateCalls: { env: Record<string, string | undefined> }[];
  seedCalls: { env: Record<string, string | undefined> }[];
  verifyCalls: { databaseUrl: string }[];
  provisionCalls: { provisionUrl: string; databaseName: string; appRole: string }[];
  containerCalls: number;
}

function setUpMocks({
  migrateOk = true,
  seedExitCode = 0,
  verifyThrows = false,
  provisionResult = {
    appUrl: "postgres://app_role:app_pw@localhost:5433/standup",
    migrateUrl: "postgres://admin:admin_pw@localhost:5433/standup",
    generatedPassword: true,
  },
  containerResult = {
    ok: true as const,
    provisionUrl: "postgres://standup:standup@localhost:5433/postgres",
  },
}: {
  migrateOk?: boolean;
  seedExitCode?: number;
  verifyThrows?: boolean;
  provisionResult?: { appUrl: string; migrateUrl: string; generatedPassword: boolean };
  containerResult?: { ok: true; provisionUrl: string } | { ok: false; reason: string };
} = {}): Mocks {
  const mocks: Mocks = {
    migrateCalls: [],
    seedCalls: [],
    verifyCalls: [],
    provisionCalls: [],
    containerCalls: 0,
  };

  vi.doMock("../scripts/lib/run-migrations.mjs", () => ({
    runMigrations: async (options: { env: Record<string, string | undefined> }) => {
      mocks.migrateCalls.push(options);
      return migrateOk ? { ok: true, exitCode: 0 } : { ok: false, exitCode: 1 };
    },
  }));

  vi.doMock("../scripts/lib/verify-round-trip.mjs", () => ({
    verifyRoundTrip: async (options: { databaseUrl: string }) => {
      mocks.verifyCalls.push(options);
      if (verifyThrows) throw new Error("round trip failed (mock)");
    },
  }));

  vi.doMock("../scripts/lib/provision-db.mjs", () => ({
    provisionAppDatabase: (options: {
      provisionUrl: string;
      databaseName: string;
      appRole: string;
    }) => {
      mocks.provisionCalls.push(options);
      return provisionResult;
    },
  }));

  vi.doMock("../scripts/lib/container-provision.mjs", () => ({
    attemptContainerProvision: async () => {
      mocks.containerCalls += 1;
      return containerResult;
    },
  }));

  vi.doMock("node:child_process", () => ({
    spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      mocks.seedCalls.push({ env: opts.env });
      return fakeChild(seedExitCode);
    },
  }));

  return mocks;
}

describe("runInitSequence", () => {
  afterEach(() => {
    vi.doUnmock("../scripts/lib/run-migrations.mjs");
    vi.doUnmock("../scripts/lib/verify-round-trip.mjs");
    vi.doUnmock("../scripts/lib/provision-db.mjs");
    vi.doUnmock("../scripts/lib/container-provision.mjs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("accept — migrates, seeds and verifies all against the one supplied connection; never provisions", async () => {
    const mocks = setUpMocks();
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "accept", databaseUrl: "postgres://someone:pw@host/db" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.databaseUrl).toBe("postgres://someone:pw@host/db");
    expect(result.source).toBe("accepted");
    expect(mocks.provisionCalls).toHaveLength(0);
    expect(mocks.containerCalls).toBe(0);
    expect(mocks.migrateCalls[0]?.env.DATABASE_URL).toBe("postgres://someone:pw@host/db");
    expect(mocks.seedCalls[0]?.env.DATABASE_URL).toBe("postgres://someone:pw@host/db");
    expect(mocks.verifyCalls[0]?.databaseUrl).toBe("postgres://someone:pw@host/db");
  });

  it("provision — migrates against the PROVISIONING url, seeds and verifies against the APPLICATION url, and they differ", async () => {
    const mocks = setUpMocks();
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: {
        kind: "provision",
        provisionUrl: "postgres://admin:adminpw@host/postgres",
        databaseName: "standup",
        appRole: "standup_app",
      },
      log: fakeLog(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.source).toBe("provisioned");
    expect(result.appRole).toBe("standup_app");
    expect(mocks.provisionCalls).toHaveLength(1);
    expect(mocks.provisionCalls[0]).toMatchObject({
      provisionUrl: "postgres://admin:adminpw@host/postgres",
      databaseName: "standup",
      appRole: "standup_app",
    });

    const migrateUrl = mocks.migrateCalls[0]?.env.DATABASE_URL;
    const seedUrl = mocks.seedCalls[0]?.env.DATABASE_URL;
    const verifyUrl = mocks.verifyCalls[0]?.databaseUrl;

    expect(migrateUrl).toBe("postgres://admin:admin_pw@localhost:5433/standup"); // provisioning role
    expect(seedUrl).toBe("postgres://app_role:app_pw@localhost:5433/standup"); // application role
    expect(verifyUrl).toBe("postgres://app_role:app_pw@localhost:5433/standup"); // application role
    expect(migrateUrl).not.toBe(seedUrl); // the property this whole test exists to pin
    expect(result.databaseUrl).toBe(seedUrl); // what gets written to local config is the app role's, never the admin's
  });

  it("auto — tries the container runtime, then provisions from what it returns, exactly like an explicit --provision-url", async () => {
    const mocks = setUpMocks();
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "auto", databaseName: "standup", appRole: "standup_app" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.source).toBe("provisioned-via-container");
    expect(mocks.containerCalls).toBe(1);
    expect(mocks.provisionCalls[0]?.provisionUrl).toBe(
      "postgres://standup:standup@localhost:5433/postgres",
    );
  });

  it("auto — when the container runtime can't provide a connection, reports 'container' rather than abandoning, and never touches provisioning", async () => {
    const mocks = setUpMocks({ containerResult: { ok: false, reason: "no container runtime" } });
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "auto", databaseName: "standup", appRole: "standup_app" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.stage).toBe("container");
    // The fallback text MILESTONES.md #80 asks for: never abandon, point at
    // the supported way out.
    expect(result.message).toContain("--database-url");
    expect(result.message).toContain("--provision-url");
    expect(mocks.provisionCalls).toHaveLength(0);
    expect(mocks.migrateCalls).toHaveLength(0);
  });

  it("stops at 'migrate' and never seeds when migrations fail", async () => {
    const mocks = setUpMocks({ migrateOk: false });
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "accept", databaseUrl: "postgres://x/y" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.stage).toBe("migrate");
    expect(mocks.seedCalls).toHaveLength(0);
  });

  it("stops at 'seed' and never verifies when seeding fails", async () => {
    const mocks = setUpMocks({ seedExitCode: 1 });
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "accept", databaseUrl: "postgres://x/y" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.stage).toBe("seed");
    expect(mocks.verifyCalls).toHaveLength(0);
  });

  it("reports 'verify' when migrate and seed succeeded but the round trip failed", async () => {
    setUpMocks({ verifyThrows: true });
    vi.resetModules();
    const { runInitSequence } = await import("../scripts/lib/run-init.mjs");

    const result = await runInitSequence({
      source: { kind: "accept", databaseUrl: "postgres://x/y" },
      log: fakeLog(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.stage).toBe("verify");
  });
});
