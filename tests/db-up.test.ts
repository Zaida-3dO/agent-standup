// The self-test for `scripts/db-up.mjs` and
// `scripts/lib/prisma-client-state.mjs` — the two setup steps that used to
// report success without providing it.
//
// Following the precedent `tests/check-external-refs.test.ts` sets: a gate is
// only proven by seeding the condition it exists to catch and watching it
// fire. Both scripts here are *about* failing correctly, so a test that only
// ever observed them succeed would be testing nothing.
//
// `run` is injected throughout rather than shelling out to a real `docker`,
// because the states worth asserting — daemon absent, daemon installed but
// stopped, container up but Postgres not yet answering — cannot all be
// produced on one machine on demand. The one thing a fake cannot prove is
// that `daemonState` reads a real `docker info` correctly; that is asserted
// against the real binary's *absence* in the last test, which is the state
// this development machine is actually in.
import { describe, expect, it } from "vitest";
// Plain JS, deliberately: these run as `node scripts/…` with no build step.
import {
  DAEMON_ADVICE,
  DB_URL,
  DbUpError,
  daemonState,
  dbUp,
  waitForReady,
} from "../scripts/db-up.mjs";
import {
  FIX_COMMAND,
  adviceFor,
  assertPrismaClientReady,
  prismaClientProblem,
} from "../scripts/lib/prisma-client-state.mjs";

/**
 * A `spawnSync` stand-in returning canned results, recording what it ran.
 *
 * Keyed by the first argument (`info`, `compose`), so a test states only the
 * call it cares about and every other call succeeds by default. It satisfies
 * the script's own `RunCommand` type without casting, which is the point of
 * that type being narrow.
 */
type FakeResult = { status?: number | null; error?: { code?: string }; stderr?: string };

function fakeRun(results: Record<string, FakeResult>) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const key = args[0] ?? "";
    return { status: 0, stderr: "", ...(results[key] ?? {}) };
  };
  return { run, calls };
}

describe("db:up — the daemon has to be reachable before anything else", () => {
  it("reports an absent docker binary as absent, not as a stopped daemon", () => {
    // ENOENT is what `spawnSync` gives when there is no executable. The
    // advice for "not installed" and "not running" are different actions, so
    // conflating them hands the reader a step they cannot take.
    const { run } = fakeRun({ info: { status: null, error: { code: "ENOENT" } } });
    expect(daemonState(run)).toBe("absent");
  });

  it("reports a shell's 'not recognized' as absent too", () => {
    // On Windows a missing command can surface as shell text and a non-zero
    // status rather than as ENOENT. Same problem, same advice.
    const { run } = fakeRun({
      info: { status: 1, stderr: "'docker' is not recognized as an internal or external command" },
    });
    expect(daemonState(run)).toBe("absent");
  });

  it("reports an installed-but-stopped daemon as unreachable", () => {
    const { run } = fakeRun({
      info: {
        status: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      },
    });
    expect(daemonState(run)).toBe("unreachable");
  });

  it("reports a live daemon as ready", () => {
    const { run } = fakeRun({ info: { status: 0 } });
    expect(daemonState(run)).toBe("ready");
  });

  it("refuses to run compose at all when the daemon is unreachable", async () => {
    const { run, calls } = fakeRun({ info: { status: 1, stderr: "Cannot connect" } });

    await expect(dbUp({ run, log: () => {} })).rejects.toThrow(DbUpError);

    // The behaviour that matters, not just the throw: it must not have gone
    // on to run `compose up` and leave the reader reading its output for a
    // cause that is one line above it.
    expect(calls.map((c) => c[1])).not.toContain("compose");
  });

  it("names the next action in every unavailable state", () => {
    // A setup script that fails without saying what to do sends the reader to
    // the compose file to work out what the script already knew.
    expect(DAEMON_ADVICE.absent).toContain("Install Docker");
    expect(DAEMON_ADVICE.unreachable).toContain("Start Docker Desktop");
    // Both offer the escape hatch for someone who already runs their own
    // Postgres and does not need Docker at all.
    for (const advice of Object.values(DAEMON_ADVICE)) {
      expect(advice).toContain("TEST_DATABASE_URL");
      expect(advice).toContain(DB_URL);
    }
  });
});

describe("db:up — success means a database answered, not that a container was created", () => {
  it("fails when the container starts but nothing ever answers", async () => {
    // The failure `docker compose up -d` could never report: it returns when
    // the container is CREATED. A developer whose Postgres never becomes
    // usable would otherwise get a clean exit and a broken test run.
    const { run } = fakeRun({});
    const wait = async () => false;

    await expect(dbUp({ run, wait, log: () => {} })).rejects.toThrow(/no database answered/);
  });

  it("succeeds only after the probe reports a live database", async () => {
    const { run, calls } = fakeRun({});
    const messages: string[] = [];

    await dbUp({ run, wait: async () => true, log: (m: string) => messages.push(m) });

    expect(calls.map((c) => c.join(" "))).toContain("docker compose up -d db");
    expect(messages.join("\n")).toContain("TEST_DATABASE_URL");
  });

  it("keeps polling while the database is still starting, rather than giving up on the first refusal", async () => {
    // The window this closes: Postgres accepts a TCP connection while still
    // refusing queries. A single probe would call that a failure.
    let attempts = 0;
    const probe = async () => ++attempts >= 3;

    const ready = await waitForReady({ probe, intervalMs: 0, timeoutMs: 10_000 });

    expect(ready).toBe(true);
    expect(attempts).toBe(3);
  });

  it("gives up once the deadline passes, rather than polling forever", async () => {
    let attempts = 0;
    const probe = async () => {
      attempts += 1;
      return false;
    };
    // A clock that jumps past the deadline on its second reading.
    let readings = 0;
    const now = () => (readings++ === 0 ? 0 : 999_999);

    const ready = await waitForReady({ probe, now, intervalMs: 0, timeoutMs: 1_000 });

    expect(ready).toBe(false);
    // Not vacuous: it did probe, it just stopped. A `waitForReady` that
    // returned false without ever probing would also satisfy the line above.
    expect(attempts).toBeGreaterThan(0);
  });
});

describe("a missing Prisma client is reported as itself", () => {
  it("recognises the ungenerated placeholder from its import error", () => {
    const load = () => {
      throw new Error('@prisma/client did not initialize yet. Please run "prisma generate"');
    };
    expect(prismaClientProblem(load)).toBe("ungenerated");
  });

  it("recognises a stub that imports cleanly but exports no client", () => {
    // The state this development worktree was actually in after `npm ci`:
    // the module resolves, and there is no `PrismaClient` constructor on it.
    expect(prismaClientProblem(() => ({}))).toBe("ungenerated");
  });

  it("tells an absent package apart from an ungenerated one", () => {
    // Different fixes — `npm ci` first, versus `prisma generate` alone.
    const load = () => {
      throw new Error("Cannot find module '@prisma/client'");
    };
    expect(prismaClientProblem(load)).toBe("missing-package");
  });

  it("passes a real generated client", () => {
    expect(prismaClientProblem(() => ({ PrismaClient: class {} }))).toBeNull();
  });

  it("names the exact command in the advice, for both problems", () => {
    // The whole point of the check: one sentence that fixes it, rather than
    // six failures that read as defects in the code under test.
    expect(adviceFor("ungenerated")).toContain(FIX_COMMAND);
    expect(adviceFor("missing-package")).toContain(FIX_COMMAND);
    expect(adviceFor("missing-package")).toContain("npm ci");
  });

  it("throws that advice rather than letting the suite fail six times over", () => {
    expect(() => assertPrismaClientReady(() => ({}))).toThrow(/prisma generate/);
  });

  it("does not throw for a healthy client", () => {
    expect(() => assertPrismaClientReady(() => ({ PrismaClient: class {} }))).not.toThrow();
  });

  it("passes against the client this very run is using", () => {
    // Not a tautology with the fakes above: this is the real resolver against
    // the real `node_modules`, so it would fail in a worktree where nobody
    // had run `prisma generate` — which is exactly the trap, and it means
    // this suite cannot be green in a tree the check would reject.
    expect(prismaClientProblem()).toBeNull();
  });
});
