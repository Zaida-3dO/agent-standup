// The rules engine's refusals reach a log (MILESTONES.md #97).
//
// Logged **where the rule fires**, not at the responder. That is the whole
// point of this half of the row, and it is a claim about location rather
// than about volume: by the time a refusal reaches an adapter it is a
// `code`, a `guard` id and a message, while the item it was about, the pair
// it was moving between and the `details` the guard computed are gone — and
// the API responder deliberately logs only `internal` anyway, so a
// `guard_rejected` reached no log at all.
//
// Everything here runs against a scratch `GuardRegistry` and a stub
// transaction handle: `runGuards` issues no query of its own, so none of
// this needs a database.
//
// The file covers **nudges** as well as refusals now, because both are the
// guard layer speaking and one call reports both: `runGuards` answers
// `{rejection?, nudges}`, a refusal still stops the run where it is while a
// nudge does not. Those two behaviours are what most of the shape tests
// below are about.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  GuardRegistry,
  guardNudged,
  guardOk,
  guardRejected,
  runGuards,
  type Guard,
  type GuardableItem,
} from "@/lib/service/state-machine/guard";
import { defaultSnapshot } from "@/lib/settings";
import { captureLogs, oneRecord, type CapturedLogs } from "./helpers/capture-logs";

const ITEM: GuardableItem = {
  id: "item-under-test",
  kind: "task",
  state: "executing",
  blockedReason: null,
  blockedOnType: null,
  blockedOnPersonId: null,
  unblockAt: null,
  pauseReason: null,
  resumeCondition: null,
  needsVisualReview: false,
  mergeAuthority: "needs_approval",
};

const MSG = "Guard refused a transition.";
const NUDGE_MSG = "Guard nudged an applied transition.";

function input(overrides: { requestId?: string } = {}) {
  return {
    item: ITEM,
    from: "executing",
    to: "merged",
    fields: {},
    db: {} as never,
    settings: defaultSnapshot(),
    ...overrides,
  };
}

function registryWith(...guards: Guard[]): GuardRegistry {
  const registry = new GuardRegistry();
  for (const guard of guards) registry.register(guard);
  return registry;
}

let logs: CapturedLogs;
let originalLevel: string | undefined;

beforeEach(() => {
  originalLevel = process.env.LOG_LEVEL;
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("runGuards logging", () => {
  test("logs the refusal WITH the reasoning that only exists here", async () => {
    // The details and the item id are what an adapter never sees. If this
    // line carried only the guard id it would add nothing the responder
    // could not already have said.
    const registry = registryWith({
      id: "test.needs_commit",
      description: "test",
      appliesTo: () => true,
      check: () =>
        guardRejected("A merge needs a commit sha.", {
          fields: ["commit_sha"],
          details: { looked_for: "artifact", found: 0 },
        }),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    const record = oneRecord(logs.stderr(), MSG);
    expect(record?.guard).toBe("test.needs_commit");
    expect(record?.itemId).toBe("item-under-test");
    expect(record?.from).toBe("executing");
    expect(record?.to).toBe("merged");
    expect(record?.reason).toBe("A merge needs a commit sha.");
    expect(record?.fields).toEqual(["commit_sha"]);
    expect(record?.details).toEqual({ looked_for: "artifact", found: 0 });
  });

  test("logs at INFO, so it is on at the default threshold", async () => {
    // A guard refusing is the system working — required-field checks, not
    // walls. At `warn` or `error`, thousands of correct refusals would sit
    // in the same stream as the failures that need a human, which is how
    // those stop being read. At `info` an operator chasing a stuck item
    // sees it without raising the level.
    process.env.LOG_LEVEL = "info";
    const registry = registryWith({
      id: "test.refuses",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no"),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    const record = oneRecord(logs.stderr(), MSG);
    expect(record?.level).toBe("info");
  });

  test("writes to STDERR and never to stdout", async () => {
    const registry = registryWith({
      id: "test.stream",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no"),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    expect(oneRecord(logs.stderr(), MSG)).toBeDefined();
    expect(logs.stdout()).toEqual([]);
  });

  test("carries the request id, so a refusal joins the call that provoked it", async () => {
    const registry = registryWith({
      id: "test.correlated",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no"),
    });

    await runGuards(registry.applicable("executing", "merged"), input({ requestId: "req-42" }));

    expect(oneRecord(logs.stderr(), MSG)?.requestId).toBe("req-42");
  });

  test("omits the request id rather than writing it empty when there is none", async () => {
    // A guard's decision must not depend on it, so it is optional — and an
    // absent key beats a `null` a reader has to look past.
    const registry = registryWith({
      id: "test.uncorrelated",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no"),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    expect(oneRecord(logs.stderr(), MSG)).not.toHaveProperty("requestId");
  });

  test("writes NOTHING when every guard allows the move", async () => {
    // The line is about refusals. A line per allowed transition would be
    // one per successful state change on a busy installation, which is the
    // volume that makes a log unreadable.
    const registry = registryWith({
      id: "test.allows",
      description: "test",
      appliesTo: () => true,
      check: () => guardOk,
    });

    const outcome = await runGuards(registry.applicable("executing", "merged"), input());

    expect(outcome.rejection).toBeUndefined();
    expect(outcome.nudges).toEqual([]);
    expect(oneRecord(logs.stderr(), MSG)).toBeUndefined();
    expect(oneRecord(logs.stderr(), NUDGE_MSG)).toBeUndefined();
  });

  test("writes NOTHING when no guard applies to the pair", async () => {
    // `appliesTo` returning false is "this rule has nothing to say", not a
    // decision — so there is nothing to record.
    const registry = registryWith({
      id: "test.never_applies",
      description: "test",
      appliesTo: () => false,
      check: () => guardRejected("would refuse if asked"),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    expect(oneRecord(logs.stderr(), MSG)).toBeUndefined();
    expect(oneRecord(logs.stderr(), NUDGE_MSG)).toBeUndefined();
  });

  test("logs the nudge too, WITH the reasoning that only exists here", async () => {
    // The nudge line answers "why did that move come back with a warning"
    // from the log alone. Same field set a refusal carries — only the
    // message differs — because what an adapter sees is the same on both
    // paths while the item, the pair and the `requestId` are not.
    const reason = "The finish landed while a child was still actionable.";
    const registry = registryWith({
      id: "test.child_open",
      description: "test",
      appliesTo: () => true,
      check: () => guardNudged(reason),
    });

    const outcome = await runGuards(
      registry.applicable("executing", "merged"),
      input({ requestId: "req-7" }),
    );

    expect(outcome.rejection).toBeUndefined();
    expect(outcome.nudges).toEqual([{ guard: "test.child_open", message: reason }]);

    const record = oneRecord(logs.stderr(), NUDGE_MSG);
    expect(record?.level).toBe("info");
    expect(record?.guard).toBe("test.child_open");
    expect(record?.itemId).toBe("item-under-test");
    expect(record?.from).toBe("executing");
    expect(record?.to).toBe("merged");
    expect(record?.reason).toBe(reason);
    expect(record?.requestId).toBe("req-7");
    expect(oneRecord(logs.stderr(), MSG)).toBeUndefined();
  });

  test("every applicable nudging guard speaks — a nudge does not stop the run", async () => {
    // The other direction of the rule the refusal tests pin: a rejection
    // breaks off the evaluation, nudges do not. Every applicable guard gets
    // to speak, in registration order, so the caller receives the whole set
    // of advice rather than only the first complaint — one missing piece of
    // evidence repaired should not hide that a second is still missing.
    const registry = registryWith(
      {
        id: "test.nudge_a",
        description: "test",
        appliesTo: () => true,
        check: () => guardNudged("a first"),
      },
      {
        id: "test.silent",
        description: "test",
        appliesTo: () => true,
        check: () => guardOk,
      },
      {
        id: "test.nudge_b",
        description: "test",
        appliesTo: () => true,
        check: () => guardNudged("b second"),
      },
    );

    const outcome = await runGuards(registry.applicable("executing", "merged"), input());

    expect(outcome.rejection).toBeUndefined();
    expect(outcome.nudges).toEqual([
      { guard: "test.nudge_a", message: "a first" },
      { guard: "test.nudge_b", message: "b second" },
    ]);
    const lines = logs.stderr().filter((record) => record.msg === NUDGE_MSG);
    expect(lines.map((line) => line.guard)).toEqual(["test.nudge_a", "test.nudge_b"]);
    expect(logs.stdout()).toEqual([]);
  });

  test("logs ONE line for the guard that fired, not one per guard evaluated", async () => {
    // `runGuards` stops at the first rejection so that the rejection a
    // caller receives is unambiguously one rule's. The log has to agree:
    // two lines would suggest two rules refused, and the second guard here
    // never even ran. The first guard's nudge is the exception that proves
    // the rule's shape: advice never stops an evaluation, so its line was
    // already written before the wall came down.
    const registry = registryWith(
      {
        id: "test.first",
        description: "test",
        appliesTo: () => true,
        check: () => guardNudged("a warning that stopped nothing"),
      },
      {
        id: "test.second",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("the one that fired"),
      },
      {
        id: "test.third",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("never reached"),
      },
    );

    const outcome = await runGuards(registry.applicable("executing", "merged"), input());

    // `oneRecord` throws on more than one match, which is half the
    // assertion; the guard ids are the other half.
    expect(oneRecord(logs.stderr(), MSG)?.guard).toBe("test.second");
    expect(oneRecord(logs.stderr(), NUDGE_MSG)?.guard).toBe("test.first");
    expect(outcome.nudges).toEqual([
      { guard: "test.first", message: "a warning that stopped nothing" },
    ]);
  });

  test("omits fields and details when the guard supplied none", async () => {
    const registry = registryWith({
      id: "test.bare",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("bare refusal"),
    });

    await runGuards(registry.applicable("executing", "merged"), input());

    const record = oneRecord(logs.stderr(), MSG);
    expect(record).not.toHaveProperty("fields");
    expect(record).not.toHaveProperty("details");
    expect(record?.reason).toBe("bare refusal");
  });

  test("still hands back the GuardRejectedError it always did", async () => {
    // Logging and nudging are additive. A change that came at the cost of
    // the rejection's shape would break every adapter's rendering of it.
    // `runGuards` now answers a `{rejection?, nudges}` pair; the error
    // inside that pair is the same object, unchanged.
    const registry = registryWith({
      id: "test.unchanged",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no", { fields: ["state"], details: { why: "because" } }),
    });

    const outcome = await runGuards(registry.applicable("executing", "merged"), input());

    expect(outcome.nudges).toEqual([]);
    expect(outcome.rejection?.guard).toBe("test.unchanged");
    expect(outcome.rejection?.code).toBe("guard_rejected");
    expect(outcome.rejection?.fields).toEqual(["state"]);
    expect(outcome.rejection?.details).toEqual({ why: "because" });
  });
});
