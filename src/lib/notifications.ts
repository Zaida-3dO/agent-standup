// Notification rules — SCHEMA.md §1.1b. Evaluates the standing/one-off rule
// shape (`{ notify, when_all?, when_any? }`) against a field snapshot and
// decides who to tell, on the edge of a rule becoming true.
//
// This module is deliberately DB-free: the shape it evaluates is two plain
// objects (before/after field values), so the evaluator is pure and every
// behaviour here is provable without a database. The service layer (once
// #27 lands transitions) is the intended caller — it reads `notify.doc` from
// the resolved settings snapshot, calls `evaluateRules` with the item's
// before/after field snapshot, and hands any recipients to that capability.
// That wiring is not this row's job; this row is the evaluator itself.
//
// DECISIONS.md §13a: "the user's flat two-bucket shape beat my nested one —
// no polymorphic arrays, three-line evaluator." Kept exactly that shape.

/** The four operators SCHEMA.md §1.1b allows. Closed set — no parser. */
export type NotifyOperator = "eq" | "neq" | "in" | "changed";

/**
 * The field whitelist, verbatim from SCHEMA.md §1.1b. Nothing arbitrary —
 * `custom_fields` is explicitly excluded there ("not addressable by
 * notification rules"), and this union is the mechanism that keeps it that
 * way: a condition naming any other field fails to type-check, and at
 * runtime `evaluateCondition` treats an unwhitelisted field the same as one
 * that is merely absent — never true.
 *
 * `assignee` is listed in SCHEMA.md but has no column on `Item` — it is
 * derived from `assignments` (SCHEMA.md §2), so a snapshot passed here
 * carries it as a computed key the same as any stored field. That's a
 * deliberate parity: the whitelist names what a rule may *ask about*, not
 * where the value physically lives.
 *
 * **Casing, stated so the next row does not have to rediscover it.** These
 * spellings are `snake_case`, matching SCHEMA.md §1.1b exactly — do not
 * change them to match the database. `Item`'s own Prisma columns are
 * `camelCase` (`prisma/schema.prisma`: `blockedOnPersonId`, `driveMode`,
 * `mergeAuthority`, …), so a snapshot built by reading `ItemRecord`
 * (`src/lib/service/items/row.ts`) directly has the *wrong* key casing for
 * three of these nine fields. `isNotifyField`/`evaluateCondition` do not
 * — and are not meant to — bridge that gap: an unrecognised spelling
 * evaluates to `false`, which is the safe failure direction (a rule that
 * cannot fire is discoverable; a rule that fires on the wrong field is not)
 * but it is still a silent one. **Whoever builds the before/after snapshot
 * at the eventual mutation call site (#27 or a follow-up) owns mapping
 * `blockedOnType → blocked_on_type`, `blockedOnPersonId →
 * blocked_on_person`, `driveMode → drive_mode`, `mergeAuthority →
 * merge_authority` before calling `evaluateRules` — this module has no way
 * to enforce that mapping happened, only to fail closed if it didn't.**
 */
export const NOTIFY_FIELD_WHITELIST = [
  "state",
  "blocked_on_type",
  "blocked_on_person",
  "area",
  "repo",
  "priority",
  "drive_mode",
  "merge_authority",
  "assignee",
] as const;

export type NotifyField = (typeof NOTIFY_FIELD_WHITELIST)[number];

const NOTIFY_FIELD_SET: ReadonlySet<string> = new Set(NOTIFY_FIELD_WHITELIST);

/** Whether `field` is one of the exact whitelisted spellings. Case-sensitive on purpose — see the module note below. */
export function isNotifyField(field: string): field is NotifyField {
  return NOTIFY_FIELD_SET.has(field);
}

/** One condition inside a `when_all`/`when_any` bucket. */
export interface NotifyCondition {
  readonly field: string;
  readonly op: NotifyOperator;
  /** Required for `eq`/`neq`/`in`; ignored (and not required) for `changed`. */
  readonly value?: unknown;
}

/** One rule — `{ notify, when_all?, when_any? }`, SCHEMA.md §1.1b. */
export interface NotifyRule {
  readonly notify: readonly string[];
  readonly whenAll?: readonly NotifyCondition[];
  readonly whenAny?: readonly NotifyCondition[];
}

/** A field snapshot — the values a rule's conditions are evaluated against. Keys are the whitelist's `snake_case` field names. */
export type FieldSnapshot = Readonly<Record<string, unknown>>;

/**
 * Evaluates one condition against `before`/`after`.
 *
 * **Whitelist enforcement lives here, not at parse time.** A condition
 * naming a field outside `NOTIFY_FIELD_WHITELIST` — including a
 * `custom_fields` key, a typo'd spelling, or a field that exists on `Item`
 * but was never added to the whitelist — evaluates to `false`
 * unconditionally, for every operator. That is what makes the whitelist a
 * property of *evaluation*: even a rule that somehow got a non-whitelisted
 * field into storage (a hand-edited row, a future format change) can never
 * fire on it. There is no "reject at write" step this depends on.
 *
 * `changed` reads only `before`/`after` and ignores `value` — SCHEMA.md
 * §1.1b: "`changed` covers 'tell me on any state change'". A field that is
 * present in `after` but absent from `before` (e.g. the item was just
 * created) counts as changed too: `undefined !== "someValue"` is exactly the
 * comparison wanted there.
 */
function evaluateCondition(
  condition: NotifyCondition,
  before: FieldSnapshot,
  after: FieldSnapshot,
): boolean {
  if (!isNotifyField(condition.field)) return false;

  const current = after[condition.field];

  switch (condition.op) {
    case "eq":
      return current === condition.value;
    case "neq":
      return current !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(current);
    case "changed":
      return before[condition.field] !== current;
    default:
      return false;
  }
}

/**
 * `all(when_all) && any(when_any)`, a missing bucket vacuously true —
 * SCHEMA.md §1.1b's exact semantics, stated as one line each.
 *
 * The two calls are `.every()` and `.some()` respectively and must stay that
 * way round: swapping them is the single-method change that collapses
 * `all`/`any` into the same behaviour whenever a rule happens to carry only
 * one bucket or every condition in a bucket shares an outcome — which is
 * exactly the defect class this row's brief calls out. `tests/notifications.test.ts`
 * carries a **mixed** case (one true condition, one false, inside one
 * bucket) specifically because that is the only shape that can tell the two
 * apart: with a single condition, or with conditions that all agree,
 * `.every()` and `.some()` return the same boolean.
 */
export function ruleMatches(
  rule: NotifyRule,
  before: FieldSnapshot,
  after: FieldSnapshot,
): boolean {
  const allOk = (rule.whenAll ?? []).every((c) => evaluateCondition(c, before, after));
  const anyOk =
    rule.whenAny === undefined || rule.whenAny.length === 0
      ? true
      : rule.whenAny.some((c) => evaluateCondition(c, before, after));
  return allOk && anyOk;
}

export interface EvaluateRulesResult {
  /** Every rule that became true on this mutation — the edge, not every rule whose condition still holds. */
  readonly fired: readonly NotifyRule[];
  /** The union of `notify` across every fired rule, de-duplicated, order preserved by first appearance. */
  readonly recipients: readonly string[];
}

/**
 * Evaluates every rule against one mutation's before/after snapshot and
 * returns which rules **fired** — became true having been false — plus the
 * union of who they name.
 *
 * **Edge-triggered, per SCHEMA.md §1.1b**: "fires when a rule becomes true
 * having been false. 'Notify on completed' must fire on the transition
 * *into* completed, not repeatedly while it sits there." A rule is
 * evaluated against `before` and `after` on every call; it fires only when
 * `matches(after) === true && matches(before) === false`. A rule that was
 * already true before this mutation and stays true after it (e.g. two edits
 * to an already-`blocked` item) does not re-fire — `tests/notifications.test.ts`
 * proves this with two sequential calls to `evaluateRules` sharing the same
 * `after` state and asserting the second returns no fired rules.
 *
 * A single-character change that would break edge-only firing: dropping the
 * `&& !matches(before)` half of the condition below, so any rule matching
 * `after` fires on every call regardless of `before`.
 */
export function evaluateRules(
  rules: readonly NotifyRule[],
  before: FieldSnapshot,
  after: FieldSnapshot,
): EvaluateRulesResult {
  const fired: NotifyRule[] = [];
  const recipients: string[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const matchesAfter = ruleMatches(rule, before, after);
    const matchesBefore = ruleMatches(rule, before, before);
    if (matchesAfter && !matchesBefore) {
      fired.push(rule);
      for (const who of rule.notify) {
        if (!seen.has(who)) {
          seen.add(who);
          recipients.push(who);
        }
      }
    }
  }

  return { fired, recipients };
}

/**
 * SCHEMA.md §1.1b's validation rule: "at least one bucket must be present" —
 * a rule with neither `when_all` nor `when_any` matches everything and fires
 * on every change, which is a footgun, not a feature. Checked at the
 * boundary that accepts a rule (the settings/administration write path,
 * once it exists), not inside the evaluator: the evaluator's job is to
 * decide whether a well-formed rule fired, not to reject a malformed one.
 */
export function hasAtLeastOneBucket(rule: NotifyRule): boolean {
  const hasAll = (rule.whenAll?.length ?? 0) > 0;
  const hasAny = (rule.whenAny?.length ?? 0) > 0;
  return hasAll || hasAny;
}

/**
 * Where notifications are actually delivered — SCHEMA.md §1.1b: "how [a
 * recipient is] reached is the configured `notify` capability — the core
 * hands over a doc path and never knows what the chat app is." §17.2's
 * registry declares `notify.doc` as `path or null, default null`; `null`
 * means notifications off, including — per §17.8 — "the escalation that
 * puts a blocked item on somebody's list."
 *
 * This is a thin read, not a settings accessor of its own: `snapshot.values`
 * is already typed per key (`resolve.ts`), so `snapshot.values["notify.doc"]`
 * is already a `string | null`. This function exists only so a caller
 * doesn't have to know the exact registry key string, and so the "null
 * means off" reading is stated once rather than re-derived at every call
 * site.
 */
export function notificationsEnabled(notifyDoc: string | null): boolean {
  return notifyDoc !== null;
}
