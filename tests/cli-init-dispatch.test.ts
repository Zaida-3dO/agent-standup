// Proves `init` is dispatched *before* `resolveConfig`'s "not configured,
// stop" gate (SCHEMA.md §20, MILESTONES.md #80) — the same property
// `doctor` already has and for the same reason: establishing configuration
// is the whole job, so the command cannot itself require it to pre-exist.
//
// `@/lib/cli/init` is mocked so this proves the *routing*, not the sequence
// itself (that's `tests/cli-init-command.test.ts` and the DB-gated tests) —
// a mutant that moved the `words[0] === "init"` check to after the
// `resolveConfig` gate, or deleted it outright, would make the spy below go
// uncalled while `standup init` with nothing configured returned the
// generic "run `standup init` first" envelope instead.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("runCli — init dispatch order", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/cli/init");
    vi.resetModules();
  });

  it("reaches runInitCommand even when nothing is configured at all", async () => {
    const seen: unknown[] = [];
    vi.doMock("@/lib/cli/init", () => ({
      runInitCommand: async (options: unknown) => {
        seen.push(options);
        return {
          envelope: { ok: true, data: { source: "accepted" } },
          exitCode: 0,
        };
      },
    }));
    vi.resetModules();

    const { runCli } = await import("@/lib/cli/run");
    const outcome = await runCli(["init"], { env: {} });

    expect(seen).toHaveLength(1);
    expect(outcome.envelope).toEqual({ ok: true, data: { source: "accepted" } });
    // The tell for "this did NOT fall through resolveConfig's gate first":
    // that gate's own message names `standup init`, this one doesn't.
    expect(JSON.stringify(outcome.envelope)).not.toContain("Neither STANDUP_URL");
  });

  it("still reaches runInitCommand when --direct is given with no DATABASE_URL", async () => {
    // A stricter case: `--direct` without a database is UNCONFIGURED even
    // inside `resolveConfig` itself (tests/cli-binding-selection.test.ts).
    // `init` must bypass that too, not just the plain "nothing set" case.
    const seen: unknown[] = [];
    vi.doMock("@/lib/cli/init", () => ({
      runInitCommand: async (options: unknown) => {
        seen.push(options);
        return { envelope: { ok: true, data: {} }, exitCode: 0 };
      },
    }));
    vi.resetModules();

    const { runCli } = await import("@/lib/cli/run");
    await runCli(["init", "--direct"], { env: {} });

    expect(seen).toHaveLength(1);
  });

  it("passes the raw flags, the environment and the file config through unchanged", async () => {
    let received: { flags?: unknown; env?: unknown; file?: unknown } = {};
    vi.doMock("@/lib/cli/init", () => ({
      runInitCommand: async (options: { flags: unknown; env: unknown; file: unknown }) => {
        received = options;
        return { envelope: { ok: true, data: {} }, exitCode: 0 };
      },
    }));
    vi.resetModules();

    const { runCli } = await import("@/lib/cli/run");
    await runCli(["init", "--database-url", "postgres://x/y"], {
      env: { DATABASE_URL: "postgres://env/db" },
      file: { actor: "user-a" },
    });

    expect(received.flags).toMatchObject({ "database-url": "postgres://x/y" });
    expect(received.env).toEqual({ DATABASE_URL: "postgres://env/db" });
    expect(received.file).toEqual({ actor: "user-a" });
  });
});
