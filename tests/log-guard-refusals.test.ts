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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  GuardRegistry,
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

    const rejection = await runGuards(registry.applicable("executing", "merged"), input());

    expect(rejection).toBeUndefined();
    expect(oneRecord(logs.stderr(), MSG)).toBeUndefined();
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
  });

  test("logs ONE line for the guard that fired, not one per guard evaluated", async () => {
    // `runGuards` stops at the first rejection so that the rejection a
    // caller receives is unambiguously one rule's. The log has to agree:
    // two lines would suggest two rules refused, and the second guard here
    // never even ran.
    const registry = registryWith(
      {
        id: "test.first",
        description: "test",
        appliesTo: () => true,
        check: () => guardOk,
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

    await runGuards(registry.applicable("executing", "merged"), input());

    // `oneRecord` throws on more than one match, which is half the
    // assertion; the guard id is the other half.
    expect(oneRecord(logs.stderr(), MSG)?.guard).toBe("test.second");
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

  test("still returns the GuardRejectedError it always did", async () => {
    // Logging is additive. A log line that came at the cost of the
    // rejection's shape would break every adapter's rendering of it.
    const registry = registryWith({
      id: "test.unchanged",
      description: "test",
      appliesTo: () => true,
      check: () => guardRejected("no", { fields: ["state"], details: { why: "because" } }),
    });

    const rejection = await runGuards(registry.applicable("executing", "merged"), input());

    expect(rejection?.guard).toBe("test.unchanged");
    expect(rejection?.code).toBe("guard_rejected");
    expect(rejection?.fields).toEqual(["state"]);
    expect(rejection?.details).toEqual({ why: "because" });
  });
});
