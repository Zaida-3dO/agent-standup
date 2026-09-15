// The stop catch's server-side producer — `src/lib/interventions/stop-context.ts`,
// MILESTONES.md #47, DECISIONS.md §6.
//
// ── What these cases are actually protecting ───────────────────────────
//
// The item this was built for says it outright: **the silent case matters
// more than the firing case.** A stop catch that fires when it should is a
// useful feature; one that fires when it should not is worse than nothing,
// because §6's own reasoning is that an orchestrator which has already
// backgrounded a wait *did the right thing*, and telling it otherwise on
// every stop trains it to filter the channel. Once filtered, the channel is
// gone for the case that mattered.
//
// So the wake half gets more cases than the crew half, and each names the
// mutation it catches.
//
// ── The wire contract, which no type checks ────────────────────────────
//
// `readStopContext` (`src/lib/hook/stop-catch.ts`) parses this block field by
// field and drops anything it does not recognise, returning `undefined` when
// nothing survives. So a renamed field here is not a type error anywhere —
// it is a catch that silently never fires again. The round-trip case at the
// bottom is the only thing standing between that and a silent regression,
// and it is deliberately written against the real client parser rather than
// against a restatement of it.
import { describe, expect, it } from "vitest";
import type { TransactionHandle } from "@/lib/service/context";
import { assembleStopContext } from "@/lib/interventions/stop-context";
import { evaluateStopCatch, readStopContext } from "@/lib/hook/stop-catch";

const DEAD_AFTER = 900;
const WAIT_TIMEOUT = 240;

/**
 * A handle answering the producer's two reads, and nothing else.
 *
 * `crew` is what the count query returns; `commands` are the recent shell
 * calls the wait check reads. Anything else throws, so a query nobody
 * intended fails loudly rather than being quietly answered with `[]` — the
 * same posture the hook-decision suite takes.
 */
function handle(options: {
  readonly crew?: number | "no-row";
  readonly commands?: readonly string[];
}): TransactionHandle & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      queries.push(query);
      if (query.includes('AS "liveCrew"')) {
        return (options.crew === "no-row" ? [] : [{ liveCrew: options.crew ?? 0 }]) as T;
      }
      if (query.includes('FROM "ToolCall"')) {
        return (options.commands ?? []).map((command) => ({ command })) as T;
      }
      throw new Error(`unexpected query: ${query}`);
    },
    $executeRawUnsafe: async () => {
      throw new Error("the stop producer must never write");
    },
  } as TransactionHandle & { queries: string[] };
}

function assemble(options: { readonly crew?: number | "no-row"; readonly commands?: string[] }) {
  return assembleStopContext({
    db: handle(options),
    sessionId: "s1",
    deadAfterSeconds: DEAD_AFTER,
    waitTimeoutMaxSeconds: WAIT_TIMEOUT,
  });
}

describe("the crew half", () => {
  it("reports the count it was given", async () => {
    expect(await assemble({ crew: 3 })).toEqual({ liveCrew: 3, wakeScheduled: false });
  });

  it("reports a genuine zero rather than dropping the block", async () => {
    // Zero is a real answer — the query ran and nobody is running — and it
    // is different from the query not having answered. Collapsing the two
    // would lose the distinction the whole context discipline rests on.
    expect(await assemble({ crew: 0 })).toEqual({ liveCrew: 0, wakeScheduled: false });
  });

  it("answers undefined when the query returned no row at all", async () => {
    // A `COUNT` always returns a row, so an empty result means the query
    // did not answer. Rendering that as `{liveCrew: 0}` would send the
    // client a settled fact — "you have no crew" — that nothing
    // established. Returning `0` here passes every other case in this file
    // and fails only this one.
    expect(await assemble({ crew: "no-row" })).toBeUndefined();
  });
});

describe("the wake half — the silent case", () => {
  it("is silent about the wake when no shell call looks like a wait", async () => {
    const context = await assemble({ crew: 2, commands: ["ls -la", "git status", "npm test"] });
    expect(context).toEqual({ liveCrew: 2, wakeScheduled: false });
  });

  it("spots a backgrounded wait and reports it", async () => {
    // The case §6 exists to protect: this orchestrator did the right thing,
    // so the catch must not speak to it.
    const context = await assemble({
      crew: 2,
      commands: ["standup crew wait --since 4120 &"],
    });
    expect(context).toEqual({ liveCrew: 2, wakeScheduled: true });
  });

  it("spots the wait among other calls rather than only as the newest", async () => {
    // A session backgrounds a wait and then carries on working, which is
    // the entire point of backgrounding one. Reading only the most recent
    // call would miss every real wait, so this fails a `[0]`-only check.
    const context = await assemble({
      crew: 1,
      commands: ["git status", "npm test", "standup crew wait --since 99 &", "ls"],
    });
    expect(context?.wakeScheduled).toBe(true);
  });

  it("recognises the wait however the binary is spelled", async () => {
    for (const command of [
      "standup crew wait --since 1",
      "npx standup crew wait --since 1 &",
      "/usr/local/bin/standup crew wait --since 1 &",
      "node dist/cli.js standup crew wait --since 1",
    ]) {
      const context = await assemble({ crew: 1, commands: [command] });
      expect(context?.wakeScheduled, command).toBe(true);
    }
  });

  it("does not mistake a different standup command for a wait", async () => {
    // Under-matching is the safe direction, but over-matching is the
    // dangerous one: a false positive here silences the catch for a session
    // with crew running and nothing coming back for them, which is the
    // whole situation it exists to catch.
    for (const command of [
      "standup my-work",
      "standup crew name",
      "standup orientation",
      "echo 'crew wait'",
      "git commit -m 'crew wait for the results'",
    ]) {
      const context = await assemble({ crew: 1, commands: [command] });
      expect(context?.wakeScheduled, command).toBe(false);
    }
  });
});

describe("what the producer refuses to do", () => {
  it("never writes", async () => {
    // The handle throws on `$executeRawUnsafe`, so this passing is the
    // assertion. `hook_decision` is declared `kind: "read"`.
    await expect(assemble({ crew: 1 })).resolves.toBeDefined();
  });

  it("leaves unfinishedWork absent rather than guessing at it", async () => {
    // I2's reasoning, enforced: "whether a row is unblocked" has no answer
    // in this schema, and the rejected substitute would fire on every leaf
    // in the backlog. The client reads an absent field as "nobody counted"
    // and stays silent, which is the honest outcome. A future change that
    // populated this from open-and-not-blocked rows fails here.
    const context = await assemble({ crew: 2 });
    expect(context).not.toHaveProperty("unfinishedWork");
  });

  it("makes exactly two reads, both bounded", async () => {
    const db = handle({ crew: 1, commands: [] });
    await assembleStopContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      waitTimeoutMaxSeconds: WAIT_TIMEOUT,
    });
    expect(db.queries).toHaveLength(2);
    // The shell read is bounded. An unbounded read on a session with a long
    // history is the cost this bound exists to avoid.
    expect(db.queries.some((query) => query.includes("LIMIT"))).toBe(true);
  });

  it("skips the shell read entirely when the crew count did not answer", async () => {
    // No point asking about a wake for a session whose crew could not be
    // established — the block is not going to be sent either way.
    const db = handle({ crew: "no-row" });
    await assembleStopContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      waitTimeoutMaxSeconds: WAIT_TIMEOUT,
    });
    expect(db.queries).toHaveLength(1);
  });

  it("uses the Fleet page's liveness notion, not the stored column alone", async () => {
    // #400's defect, pinned: `Assignment.liveness` is advanced only by the
    // sweep, so between passes it reports the last pass's verdict — which is
    // how the Fleet page counted 27 claims as "Running" that had been gone
    // for days. The count must require BOTH `running` and a recent
    // `lastActive`. Dropping either half of that conjunction fails here.
    const db = handle({ crew: 1 });
    await assembleStopContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      waitTimeoutMaxSeconds: WAIT_TIMEOUT,
    });
    const countQuery = db.queries.find((query) => query.includes('AS "liveCrew"')) ?? "";
    expect(countQuery).toMatch(/liveness"?\s*=\s*'running'/);
    expect(countQuery).toMatch(/lastActive/);
  });

  it("excludes the asking session, so zero is reachable", async () => {
    // The session assembling this is running by definition. Counting it
    // would put a floor of one under the number and make "nobody is
    // running" inexpressible — which is the whole signal.
    const db = handle({ crew: 1 });
    await assembleStopContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      waitTimeoutMaxSeconds: WAIT_TIMEOUT,
    });
    const countQuery = db.queries.find((query) => query.includes('AS "liveCrew"')) ?? "";
    expect(countQuery).toMatch(/sessionId"?\s*<>/);
  });
});

// ── The round trip, against the real client parser ─────────────────────
//
// These are the cases that would have caught the bug this module was
// originally written with: the wake check keyed on `ToolCall.tool =
// 'wait_for_crew'`, a column that never holds an operation name. It
// typechecked, read reasonably, matched nothing, and would have made
// `wakeScheduled` permanently false — nagging precisely the orchestrators
// who had done the right thing.
//
// Asserting through `readStopContext` and `evaluateStopCatch` rather than on
// the payload shape is what makes these cases about the feature working
// end to end rather than about this module agreeing with itself.
describe("end to end, through the client's own parser", () => {
  const stopEvent = { eventType: "Stop" } as Parameters<typeof evaluateStopCatch>[0];

  it("a session with crew and no wake is told, and the message names the count", async () => {
    const payload = await assemble({ crew: 3, commands: ["ls"] });
    const parsed = readStopContext(payload);
    const caught = evaluateStopCatch(stopEvent, parsed);

    expect(caught).not.toBeNull();
    expect(caught?.reason).toBe("live-crew");
    expect(caught?.liveCrew).toBe(3);
    expect(caught?.text).toContain("3 crew members");
  });

  it("a session that already backgrounded a wait is NOT told", async () => {
    // The single most important case in this file. Every step is real: the
    // producer assembles, the client parses, the client evaluates. A
    // regression anywhere along that path turns this green message into a
    // nag on every stop.
    const payload = await assemble({ crew: 3, commands: ["standup crew wait --since 12 &"] });
    const caught = evaluateStopCatch(stopEvent, readStopContext(payload));

    expect(caught).toBeNull();
  });

  it("a session with no crew running is not told", async () => {
    const payload = await assemble({ crew: 0, commands: ["ls"] });
    expect(evaluateStopCatch(stopEvent, readStopContext(payload))).toBeNull();
  });

  it("a session whose crew could not be counted is not told", async () => {
    // `undefined` all the way through: no block sent, nothing parsed,
    // nothing said. "Not known" must never become a finding.
    const payload = await assemble({ crew: "no-row" });
    expect(payload).toBeUndefined();
    expect(readStopContext(payload)).toBeUndefined();
    expect(evaluateStopCatch(stopEvent, readStopContext(payload))).toBeNull();
  });

  it("the field names survive the client's parser", async () => {
    // The wire contract, asserted where it actually binds. `readStopContext`
    // drops what it does not recognise, so renaming either field here
    // produces a parsed object missing it — indistinguishable in production
    // from the server sending nothing.
    const payload = await assemble({ crew: 2, commands: ["standup crew wait --since 1 &"] });
    const parsed = readStopContext(payload);

    expect(parsed).toEqual({ liveCrew: 2, wakeScheduled: true });
  });
});
