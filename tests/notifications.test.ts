// Notification rules — SCHEMA.md §1.1b, MILESTONES.md #25.
//
// Pure module, no database: every behaviour under test is provable from
// plain objects. Per CLAUDE.md's testing tenet, every test below states the
// single-character source change that would make it fail, and the "quality
// bar" note in the brief this row was dispatched from — each is checked
// against a real mutation of src/lib/notifications.ts, not asserted in the
// abstract. See the handoff brief (checkpoints/perrin-6b3.md) for the
// mutation log.
import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  hasAtLeastOneBucket,
  isNotifyField,
  notificationsEnabled,
  ruleMatches,
  type FieldSnapshot,
  type NotifyCondition,
  type NotifyRule,
} from "@/lib/notifications";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";

// --- AC1: all-of / any-of composition, with a MIXED case ---

describe("all-of / any-of composition (AC1)", () => {
  const blocked: NotifyCondition = { field: "state", op: "eq", value: "blocked" };
  const p0: NotifyCondition = { field: "priority", op: "eq", value: "P0" };

  it("when_all requires every condition — a rule with one true and one false condition does not match", () => {
    // Mixed case: state IS blocked (true), priority is NOT P0 (false).
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [blocked, p0],
    };
    const after: FieldSnapshot = { state: "blocked", priority: "P1" };
    const before: FieldSnapshot = { state: "someday", priority: "P1" };

    // A single-character change that would break this: `.every()` →
    // `.some()` in ruleMatches's whenAll clause — with that mutation this
    // would return true (one of the two conditions matches), which is
    // exactly the "any vs all indistinguishable on a mixed case" defect
    // the brief names.
    expect(ruleMatches(rule, before, after)).toBe(false);
  });

  it("when_all matches when every condition is true", () => {
    const rule: NotifyRule = { notify: ["user-a"], whenAll: [blocked, p0] };
    const after: FieldSnapshot = { state: "blocked", priority: "P0" };
    const before: FieldSnapshot = { state: "someday", priority: "P0" };
    expect(ruleMatches(rule, before, after)).toBe(true);
  });

  it("when_any matches on the SAME mixed case that when_all rejects — the pair that actually distinguishes all from any", () => {
    // Identical fields to the when_all mixed case above: state IS blocked
    // (true), priority is NOT P0 (false). Only the bucket differs. If
    // `ruleMatches` used the same combinator for both buckets, these two
    // tests would agree instead of disagreeing — which is exactly the
    // "any and all are indistinguishable" defect this pair is written to
    // catch.
    const rule: NotifyRule = { notify: ["user-a"], whenAny: [blocked, p0] };
    const after: FieldSnapshot = { state: "blocked", priority: "P1" };
    const before: FieldSnapshot = { state: "someday", priority: "P1" };

    // A single-character change that would break this: `.some()` →
    // `.every()` in ruleMatches's whenAny clause.
    expect(ruleMatches(rule, before, after)).toBe(true);
  });

  it("when_any rejects when every condition is false", () => {
    const rule: NotifyRule = { notify: ["user-a"], whenAny: [blocked, p0] };
    const after: FieldSnapshot = { state: "someday", priority: "P1" };
    const before: FieldSnapshot = { state: "someday", priority: "P1" };
    expect(ruleMatches(rule, before, after)).toBe(false);
  });

  it("both buckets together: all(when_all) && any(when_any), a missing bucket vacuously true", () => {
    // SCHEMA.md §1.1b's third example: "web work that is either blocked or P0".
    const areaWeb: NotifyCondition = { field: "area", op: "eq", value: "web" };
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [areaWeb],
      whenAny: [blocked, p0],
    };
    const before: FieldSnapshot = { area: "web", state: "someday", priority: "P1" };

    // whenAll true (area=web), whenAny true (blocked) → fires.
    expect(ruleMatches(rule, before, { area: "web", state: "blocked", priority: "P1" })).toBe(true);
    // whenAll true (area=web), whenAny false (neither blocked nor P0) → does not fire.
    expect(ruleMatches(rule, before, { area: "web", state: "someday", priority: "P1" })).toBe(
      false,
    );
    // whenAll false (area != web), whenAny true → does not fire regardless.
    expect(ruleMatches(rule, before, { area: "infra", state: "blocked", priority: "P1" })).toBe(
      false,
    );
  });

  it("a rule with only when_all and no when_any is not blocked by the missing bucket (vacuously true)", () => {
    const rule: NotifyRule = { notify: ["user-a"], whenAll: [p0] };
    const before: FieldSnapshot = { priority: "P1" };
    const after: FieldSnapshot = { priority: "P0" };
    // A single-character change that would break this: `rule.whenAny ===
    // undefined ? true : ...` → `rule.whenAny === undefined ? false : ...`
    // in ruleMatches, which would make every when_all-only rule permanently
    // unmatchable.
    expect(ruleMatches(rule, before, after)).toBe(true);
  });
});

// --- AC2: fires on the edge only ---

describe("edge-only firing (AC2)", () => {
  it("fires exactly once across two evaluations that both see the rule as true", () => {
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "state", op: "eq", value: "completed" }],
    };

    // First mutation: someday -> completed. The rule becomes true.
    const first = evaluateRules([rule], { state: "someday" }, { state: "completed" });
    expect(first.fired).toHaveLength(1);
    expect(first.recipients).toEqual(["user-a"]);

    // Second mutation: item stays completed (e.g. an unrelated field edit).
    // `before` and `after` both already satisfy the rule, so it must not
    // fire again.
    //
    // A single-character change that would break this: dropping the
    // `&& !matchesBefore` guard in evaluateRules, so any rule matching
    // `after` fires unconditionally regardless of `before` — the second
    // call below would then report a spurious second firing.
    const second = evaluateRules([rule], { state: "completed" }, { state: "completed" });
    expect(second.fired).toHaveLength(0);
    expect(second.recipients).toEqual([]);
  });

  it("does not fire when the rule was already true before this mutation and a different field just changed", () => {
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "state", op: "eq", value: "blocked" }],
    };
    // Already blocked before this call; priority changes, state does not.
    const result = evaluateRules(
      [rule],
      { state: "blocked", priority: "P2" },
      { state: "blocked", priority: "P0" },
    );
    expect(result.fired).toHaveLength(0);
  });

  it("fires again on a second genuine edge (false -> true -> false -> true)", () => {
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "state", op: "eq", value: "blocked" }],
    };
    const first = evaluateRules([rule], { state: "someday" }, { state: "blocked" });
    expect(first.fired).toHaveLength(1);

    const unblocked = evaluateRules([rule], { state: "blocked" }, { state: "someday" });
    expect(unblocked.fired).toHaveLength(0);

    const second = evaluateRules([rule], { state: "someday" }, { state: "blocked" });
    expect(second.fired).toHaveLength(1);
  });
});

// --- AC3: whitelisted fields ---

describe("field whitelisting (AC3)", () => {
  it("isNotifyField accepts every whitelisted spelling and rejects an arbitrary one", () => {
    expect(isNotifyField("state")).toBe(true);
    expect(isNotifyField("area")).toBe(true);
    expect(isNotifyField("custom_fields")).toBe(false);
  });

  it("a change to a non-whitelisted field does not fire a rule built on `changed`", () => {
    // custom_fields is explicitly excluded by SCHEMA.md §1.1b ("Not
    // addressable by notification rules").
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "custom_fields", op: "changed" }],
    };
    const result = evaluateRules(
      [rule],
      { custom_fields: { ticket: "OLD-1" } },
      { custom_fields: { ticket: "NEW-2" } },
    );
    // A single-character change that would break this: evaluateCondition
    // checking `condition.field in after` (or similar) instead of gating on
    // `isNotifyField`, so any key present in the snapshot is addressable.
    expect(result.fired).toHaveLength(0);
    expect(result.recipients).toEqual([]);
  });

  it("a change to a field that is real but simply not on the whitelist never fires, even with eq/in", () => {
    // `title` exists on Item (SCHEMA.md §1) but is not in the whitelist.
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "title", op: "eq", value: "Ship the doors" }],
    };
    const result = evaluateRules([rule], { title: "old title" }, { title: "Ship the doors" });
    expect(result.fired).toHaveLength(0);
  });

  it("a mistyped field spelling (case) is not the whitelisted field — never matches", () => {
    // Per learnings #200: ask what spelling or shape the whitelist does not
    // see. `State` (capitalised) is not `state` — the whitelist is
    // case-sensitive, so a rule authored with the wrong case silently never
    // fires rather than fires unexpectedly. That is deliberately the
    // conservative failure direction (a rule that can't fire is discoverable
    // by "why did I never get notified"; a rule that fires on the wrong
    // field is a much harder bug to trace).
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "State", op: "eq", value: "blocked" } as unknown as NotifyCondition],
    };
    const result = evaluateRules([rule], { state: "someday" }, { state: "blocked" });
    expect(result.fired).toHaveLength(0);
  });

  it("a nested-path spelling is not a whitelisted field — the whitelist has no dotted-path form", () => {
    // Per learnings #200: nested paths are a shape the whitelist does not
    // see. There is no `"blocked_on.person"` or similar dotted form — only
    // the exact flat names in NOTIFY_FIELD_WHITELIST. A rule that tries one
    // never fires, rather than silently reaching into a sub-object.
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [
        { field: "blocked_on.person", op: "eq", value: "user-b" } as unknown as NotifyCondition,
      ],
    };
    const result = evaluateRules(
      [rule],
      { "blocked_on.person": null },
      { "blocked_on.person": "user-b" },
    );
    expect(result.fired).toHaveLength(0);
  });

  it("a field renamed between the event payload and the rule (blockedOnPersonId vs blocked_on_person) never fires on the camelCase spelling", () => {
    // Per learnings #200: a field renamed between the event and the rule.
    // ItemRecord (src/lib/service/items/row.ts) calls this field
    // `blockedOnPersonId`; SCHEMA.md §1.1b's whitelist calls it
    // `blocked_on_person`. A rule (or a caller building the snapshot) that
    // used the row's camelCase name instead of the whitelist's snake_case
    // name would silently never fire — proven here directly, so the gap is
    // visible rather than assumed closed by the two names looking similar.
    expect(isNotifyField("blockedOnPersonId")).toBe(false);
    expect(isNotifyField("blocked_on_person")).toBe(true);

    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [
        { field: "blockedOnPersonId", op: "eq", value: "user-b" } as unknown as NotifyCondition,
      ],
    };
    const result = evaluateRules(
      [rule],
      { blockedOnPersonId: null },
      { blockedOnPersonId: "user-b" },
    );
    expect(result.fired).toHaveLength(0);
  });
});

// --- AC4: reads notify.doc from settings; null means off ---

describe("notify.doc from the settings snapshot (AC4)", () => {
  it("a fresh database (default snapshot) has notify.doc = null, and notificationsEnabled reads that as off", () => {
    const snapshot = defaultSnapshot();
    // Confirms this reads the real registry default, not a value hardcoded
    // in this test file or in notifications.ts.
    expect(snapshot.values["notify.doc"]).toBeNull();
    expect(notificationsEnabled(snapshot.values["notify.doc"])).toBe(false);
  });

  it("an override that sets notify.doc to a path is read as enabled", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "notify.doc", value: "/docs/how-to-notify.md" }],
      revision: 1n,
    });
    expect(snapshot.values["notify.doc"]).toBe("/docs/how-to-notify.md");
    // A single-character change that would break this: `notifyDoc !== null`
    // → `notifyDoc === null` in notificationsEnabled, inverting the sense.
    expect(notificationsEnabled(snapshot.values["notify.doc"])).toBe(true);
  });

  it("clearing the override back to null reads as disabled again — null is a real value, not 'no row'", () => {
    // SCHEMA.md §17.2: JSON null is a legal, meaningful override value,
    // distinct from no row at all. Resolving an explicit `null` override
    // must produce the same "off" reading as the default.
    const snapshot = resolveSettings({
      overrides: [{ key: "notify.doc", value: null }],
      revision: 2n,
    });
    expect(snapshot.values["notify.doc"]).toBeNull();
    expect(notificationsEnabled(snapshot.values["notify.doc"])).toBe(false);
  });
});

// --- Validation: at least one bucket must be present (SCHEMA.md §1.1b) ---

describe("hasAtLeastOneBucket", () => {
  it("a rule with neither when_all nor when_any has no bucket", () => {
    const rule: NotifyRule = { notify: ["user-a"] };
    // A single-character change that would break this: `> 0` → `>= 0` in
    // either half of the `||`, which would make every rule report true.
    expect(hasAtLeastOneBucket(rule)).toBe(false);
  });

  it("a rule with an empty when_all array still has no bucket", () => {
    const rule: NotifyRule = { notify: ["user-a"], whenAll: [] };
    expect(hasAtLeastOneBucket(rule)).toBe(false);
  });

  it("a rule with at least one condition in either bucket has a bucket", () => {
    expect(
      hasAtLeastOneBucket({
        notify: ["user-a"],
        whenAll: [{ field: "state", op: "eq", value: "blocked" }],
      }),
    ).toBe(true);
    expect(
      hasAtLeastOneBucket({
        notify: ["user-a"],
        whenAny: [{ field: "priority", op: "eq", value: "P0" }],
      }),
    ).toBe(true);
  });
});

// --- Recipients: union across fired rules, de-duplicated ---

describe("evaluateRules recipients", () => {
  it("de-duplicates a recipient named by two rules that both fire on the same mutation", () => {
    const ruleA: NotifyRule = {
      notify: ["user-a", "user-b"],
      whenAll: [{ field: "state", op: "eq", value: "blocked" }],
    };
    const ruleB: NotifyRule = {
      notify: ["user-b"],
      whenAll: [{ field: "priority", op: "eq", value: "P0" }],
    };
    const result = evaluateRules(
      [ruleA, ruleB],
      { state: "someday", priority: "P1" },
      { state: "blocked", priority: "P0" },
    );
    expect(result.fired).toHaveLength(2);
    // user-b named by both rules but appears once, order preserved by first
    // appearance (ruleA's order).
    expect(result.recipients).toEqual(["user-a", "user-b"]);
  });

  it("only the notify list of a rule that actually fired contributes recipients", () => {
    const fires: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "state", op: "eq", value: "blocked" }],
    };
    const doesNotFire: NotifyRule = {
      notify: ["user-b"],
      whenAll: [{ field: "state", op: "eq", value: "cancelled" }],
    };
    const result = evaluateRules([fires, doesNotFire], { state: "someday" }, { state: "blocked" });
    expect(result.recipients).toEqual(["user-a"]);
  });
});

// --- `in` operator: same-field ORs (SCHEMA.md §1.1b) ---

describe("the `in` operator", () => {
  it("matches when the current value is one of the listed values", () => {
    const rule: NotifyRule = {
      notify: ["user-a"],
      whenAll: [{ field: "state", op: "in", value: ["blocked", "completed"] }],
    };
    expect(ruleMatches(rule, { state: "someday" }, { state: "blocked" })).toBe(true);
    expect(ruleMatches(rule, { state: "someday" }, { state: "cancelled" })).toBe(false);
  });
});
