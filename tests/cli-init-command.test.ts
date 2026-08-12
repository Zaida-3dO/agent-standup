// `runInitCommand` (SCHEMA.md §20, MILESTONES.md #80) — the adapter that
// turns a resolved source into an envelope, with the database-touching
// sequence injected as a fake. This is what proves the two semantics the
// row calls out explicitly:
//
//   - the provisioning connection and the application connection are
//     different values, and only the application one is ever written to
//     local configuration or exposed in the envelope;
//   - a sequence that cannot complete produces an actionable "not
//     configured" answer, never a crash and never silence.
import { describe, expect, it } from "vitest";
import { EXIT } from "@/lib/cli/envelope";
import { runInitCommand, type InitSequenceResult } from "@/lib/cli/init";
import type { InitSource } from "@/lib/cli/init/resolve";

function fakeRunInitSequence(result: InitSequenceResult, capture?: { source?: InitSource }) {
  return async ({ source }: { source: InitSource }) => {
    if (capture) capture.source = source;
    return result;
  };
}

function fakeWriteConfigFile(capture: { calls: { patch: unknown; path: string }[] }) {
  return (patch: Record<string, string>, path: string) => {
    capture.calls.push({ patch, path });
    return { ...patch };
  };
}

describe("runInitCommand — the accept path", () => {
  it("passes an accepted connection straight through and writes it to local config", async () => {
    const writes: { calls: { patch: unknown; path: string }[] } = { calls: [] };
    const outcome = await runInitCommand({
      flags: { "database-url": "postgres://someone:pw@host/db" },
      env: {},
      file: {},
      deps: {
        runInitSequence: fakeRunInitSequence({
          ok: true,
          databaseUrl: "postgres://someone:pw@host/db",
          source: "accepted",
          database: { host: "host", name: "db" },
          steps: { migrated: true, seeded: true, verified: true },
        }),
        writeConfigFile: fakeWriteConfigFile(writes) as never,
        configPath: "/fake/config.json",
      },
    });

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.envelope.ok).toBe(true);
    expect(writes.calls).toEqual([
      { patch: { databaseUrl: "postgres://someone:pw@host/db" }, path: "/fake/config.json" },
    ]);
    // Never printed: the whole connection string does not appear anywhere
    // in the rendered envelope, only structural facts (SCHEMA.md §20).
    expect(JSON.stringify(outcome.envelope)).not.toContain("postgres://someone:pw@host/db");
  });
});

describe("runInitCommand — the provision path keeps the two connections apart", () => {
  it("writes the APPLICATION role's connection string to config, never the provisioning one", async () => {
    const writes: { calls: { patch: unknown; path: string }[] } = { calls: [] };
    const capture: { source?: InitSource } = {};

    const outcome = await runInitCommand({
      flags: { "provision-url": "postgres://admin:supersecret@host/postgres" },
      env: {},
      file: {},
      deps: {
        runInitSequence: fakeRunInitSequence(
          {
            ok: true,
            databaseUrl: "postgres://standup_app:generated@host/standup",
            source: "provisioned",
            database: { host: "host", name: "standup" },
            appRole: "standup_app",
            steps: { migrated: true, seeded: true, verified: true },
          },
          capture,
        ),
        writeConfigFile: fakeWriteConfigFile(writes) as never,
        configPath: "/fake/config.json",
      },
    });

    // The sequence was invoked with the *provisioning* connection...
    expect(capture.source).toEqual({
      kind: "provision",
      provisionUrl: "postgres://admin:supersecret@host/postgres",
      databaseName: "standup",
      appRole: "standup_app",
    });
    // ...but what got written to disk, and what the envelope reports, is the
    // application role's own connection — never the admin one, and the
    // admin credential never appears anywhere in the outcome at all.
    expect(writes.calls).toEqual([
      {
        patch: { databaseUrl: "postgres://standup_app:generated@host/standup" },
        path: "/fake/config.json",
      },
    ]);
    expect(JSON.stringify(outcome.envelope)).not.toContain("supersecret");
    expect(JSON.stringify(outcome.envelope)).not.toContain("admin:supersecret");
    if (!outcome.envelope.ok) throw new Error("expected success");
    expect(outcome.envelope.data).toMatchObject({ source: "provisioned", appRole: "standup_app" });
  });
});

describe("runInitCommand — every provisioning flag reaches resolveInitSource under its own name", () => {
  it("wires --database-name, --app-role and --app-password through distinctly, not cross-mapped", async () => {
    // A mutant that swapped which parsed flag feeds which resolved field
    // (e.g. app-role's value landing in appPassword) would pass every other
    // test here, because most of them only exercise one override at a time.
    const capture: { source?: InitSource } = {};
    await runInitCommand({
      flags: {
        "provision-url": "postgres://admin/postgres",
        "database-name": "field_db",
        "app-role": "field_role",
        "app-password": "field_password",
      },
      env: {},
      file: {},
      deps: {
        runInitSequence: fakeRunInitSequence(
          {
            ok: true,
            databaseUrl: "postgres://field_role:field_password@host/field_db",
            source: "provisioned",
            database: { host: "host", name: "field_db" },
            appRole: "field_role",
            steps: { migrated: true, seeded: true, verified: true },
          },
          capture,
        ),
        writeConfigFile: () => ({}) as never,
        configPath: "/fake/config.json",
      },
    });

    expect(capture.source).toEqual({
      kind: "provision",
      provisionUrl: "postgres://admin/postgres",
      databaseName: "field_db",
      appRole: "field_role",
      appPassword: "field_password",
    });
  });
});

describe("runInitCommand — falls back to an actionable answer rather than abandoning", () => {
  it("reports exit code 4 (not configured) and names the failing stage, on a sequence failure", async () => {
    const outcome = await runInitCommand({
      flags: {},
      env: {},
      file: {},
      deps: {
        runInitSequence: fakeRunInitSequence({
          ok: false,
          stage: "container",
          message:
            "No container runtime is available. Supply one with --database-url or " +
            "--provision-url, then run `standup init` again.",
        }),
        writeConfigFile: () => ({}) as never,
        configPath: "/fake/config.json",
      },
    });

    expect(outcome.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(outcome.envelope.ok).toBe(false);
    if (outcome.envelope.ok) throw new Error("unreachable");
    // The message is what makes this "rather than abandoning": it names the
    // concrete next step (§20's own fallback), not a bare failure.
    expect(outcome.envelope.error.message).toContain("--database-url");
    expect(outcome.envelope.error.fields).toEqual(["container"]);
  });

  it("never writes to local configuration when the sequence did not succeed", async () => {
    const writes: { calls: { patch: unknown; path: string }[] } = { calls: [] };
    await runInitCommand({
      flags: {},
      env: {},
      file: {},
      deps: {
        runInitSequence: fakeRunInitSequence({
          ok: false,
          stage: "verify",
          message: "The live round trip failed.",
        }),
        writeConfigFile: fakeWriteConfigFile(writes) as never,
        configPath: "/fake/config.json",
      },
    });
    expect(writes.calls).toEqual([]);
  });
});

describe("runInitCommand — malformed input never reaches the sequence at all", () => {
  it("refuses a bare --database-url with no value, exit code 2, without invoking the sequence", async () => {
    let invoked = false;
    const outcome = await runInitCommand({
      flags: { "database-url": true },
      env: {},
      file: {},
      deps: {
        runInitSequence: async () => {
          invoked = true;
          throw new Error("must not be called");
        },
        writeConfigFile: () => ({}) as never,
      },
    });
    expect(invoked).toBe(false);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(outcome.envelope.ok).toBe(false);
  });
});
