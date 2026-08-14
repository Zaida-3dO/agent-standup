// Wires the notification evaluator (`src/lib/notifications.ts`) to the two
// mutations that change the fields rules are allowed to ask about —
// `transition_item` and `update_item`. See MILESTONES.md #101.
//
// `evaluateRules` is a pure function over two field snapshots. It has been
// correct and complete since #25 and, until this module, had no caller: no
// mutation built a snapshot, nothing read `people.notify_rules`, and a rule
// stored against a person could never fire. This module is the missing half
// — it builds the before/after snapshots, loads the rules, evaluates, and
// records the outcome.
//
// ── The casing bridge is the point of this module ───────────────────────
//
// `notifications.ts` states outright that its caller owns this, and why it
// cannot enforce it itself: the whitelist is `snake_case` (SCHEMA.md §1.1b)
// while `Item`'s Prisma columns are `camelCase`, and four of the nine fields
// differ between the two. An unrecognised spelling evaluates to `false` —
// the safe direction, but a silent one, so a snapshot built by handing
// `ItemRecord` over directly would produce rules that simply never fire on
// four fields with nothing anywhere reporting a problem.
//
// `snapshotOf` below is the mapping, written once, exported so the tests can
// assert it against `NOTIFY_FIELD_WHITELIST` rather than against a second
// hand-written list that could drift the same way.
//
// ── Failure posture: a notification never breaks a mutation ─────────────
//
// Evaluation runs inside the mutation's transaction (it reads `people`), but
// its failure is contained: `evaluateNotifications` catches, and returns a
// result carrying the error rather than throwing. A malformed `notify_rules`
// JSON blob on one person is a data problem with that row, and it must not
// be able to make an unrelated item untransitionable. The alternative —
// letting it propagate — means one bad rule blocks every mutation on every
// item, which is a much worse failure than a notification that did not go
// out.
import {
  evaluateRules,
  isNotifyField,
  type FieldSnapshot,
  type NotifyCondition,
  type NotifyRule,
} from "@/lib/notifications";
import type { TransactionHandle } from "./context";
import type { ItemRecord } from "./items/row";

/**
 * The whitelist spelling for each `ItemRecord` key that differs from it.
 *
 * Only the four that actually differ are listed; the rest (`state`, `area`,
 * `repo`, `priority`) are spelled identically on both sides. A test asserts
 * that this map plus the identical names covers the whole whitelist except
 * `assignee`, which is not an `Item` column at all — so adding a whitelist
 * entry without deciding how it is sourced fails the suite rather than
 * silently never firing.
 */
export const ITEM_FIELD_TO_NOTIFY_FIELD = {
  blockedOnType: "blocked_on_type",
  blockedOnPersonId: "blocked_on_person",
  driveMode: "drive_mode",
  mergeAuthority: "merge_authority",
} as const;

/** The whitelisted fields that are spelled the same in both worlds. */
export const IDENTICALLY_NAMED_NOTIFY_FIELDS = ["state", "area", "repo", "priority"] as const;

/**
 * Builds the field snapshot `evaluateRules` expects from one item row.
 *
 * `assignee` is passed in rather than read from the row because it is not a
 * column — SCHEMA.md §2 derives it from `assignments`. Neither transition
 * nor update touches assignments, so the same value is correct on both sides
 * of the mutation; passing it explicitly keeps that fact visible instead of
 * burying a join in here. A caller with no assignee to offer passes `null`,
 * and an `assignee` condition then evaluates against `null` on both sides —
 * never `changed`, and `eq` only against an explicit null.
 */
export function snapshotOf(item: ItemRecord, assignee: string | null): FieldSnapshot {
  return {
    state: item.state,
    area: item.area,
    repo: item.repo,
    priority: item.priority,
    blocked_on_type: item.blockedOnType,
    blocked_on_person: item.blockedOnPersonId,
    drive_mode: item.driveMode,
    merge_authority: item.mergeAuthority,
    assignee,
  };
}

/** One person's stored rules, as the evaluator consumes them. */
export interface PersonRules {
  readonly personId: string;
  readonly rules: readonly NotifyRule[];
}

/**
 * Parses one stored `notify_rules` JSON value into rules the evaluator can
 * take, discarding anything malformed.
 *
 * Stored rules are `snake_case` (`when_all`/`when_any`, SCHEMA.md §1.1b) and
 * `NotifyRule` is `camelCase` (`whenAll`/`whenAny`) — the same class of gap
 * as the field casing, one level up, and equally silent if missed: a rule
 * whose buckets both parse as `undefined` has no conditions.
 *
 * **What such a rule actually does is nothing**, which is worth stating
 * precisely because the opposite is easy to infer. `ruleMatches` does treat a
 * missing bucket as vacuously true — that much is real — but the consequence
 * does not follow, for two independent reasons. This function drops the rule
 * below (`continue`), so it never reaches the evaluator at all; and
 * `evaluateRules` (`@/lib/notifications`) is edge-triggered on
 * `matchesAfter && !matchesBefore`, so a vacuously-true rule matches both
 * snapshots and the edge never occurs. Measured: it fires zero times.
 *
 * Silence is the worse failure, not the safer one — a rule that looks
 * configured and notifies nobody reports nothing to anybody — which is why
 * this function requires at least one bucket to have survived parsing.
 *
 * Anything that is not an object, whose `notify` is not an array of strings,
 * or which ends up with no usable bucket, is dropped. Dropping is deliberate
 * over throwing: see the module header on why one malformed row must not
 * break unrelated mutations.
 */
export function parseStoredRules(stored: unknown): NotifyRule[] {
  if (!Array.isArray(stored)) return [];
  const rules: NotifyRule[] = [];

  for (const raw of stored) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;

    const notify = record.notify;
    if (!Array.isArray(notify)) continue;
    if (!notify.every((who) => typeof who === "string")) continue;

    const whenAll = parseConditions(record.when_all);
    const whenAny = parseConditions(record.when_any);
    // Neither bucket usable means the rule has no conditions, so it is
    // dropped here rather than handed on — `hasAtLeastOneBucket`'s footgun,
    // SCHEMA.md §1.1b. **This `continue` is why such a rule fires zero times
    // rather than constantly**; see the docstring above.
    if (whenAll.length === 0 && whenAny.length === 0) continue;

    rules.push({
      notify: notify as string[],
      ...(whenAll.length > 0 ? { whenAll } : {}),
      ...(whenAny.length > 0 ? { whenAny } : {}),
    });
  }

  return rules;
}

function parseConditions(raw: unknown): NotifyCondition[] {
  if (!Array.isArray(raw)) return [];
  const conditions: NotifyCondition[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const field = record.field;
    const op = record.op;
    if (typeof field !== "string" || typeof op !== "string") continue;
    if (op !== "eq" && op !== "neq" && op !== "in" && op !== "changed") continue;
    // Drop a condition naming an unwhitelisted field here as well as in the
    // evaluator. Both are needed and neither is redundant: the evaluator's
    // check is what makes the whitelist a property of evaluation, and this
    // one is what stops a rule *surviving* parsing with nothing but
    // unwhitelisted conditions — which would leave it with an empty bucket
    // and, per the doc above, matching everything.
    if (!isNotifyField(field)) continue;
    conditions.push({ field, op, value: record.value });
  }

  return conditions;
}

/** Every non-archived person that has rules stored. */
export async function loadPersonRules(db: TransactionHandle): Promise<PersonRules[]> {
  const rows = await db.$queryRawUnsafe<{ id: string; notifyRules: unknown }[]>(
    `SELECT "id", "notifyRules" FROM "Person"
      WHERE "notifyRules" IS NOT NULL AND "archivedAt" IS NULL`,
  );

  const loaded: PersonRules[] = [];
  for (const row of rows) {
    const rules = parseStoredRules(row.notifyRules);
    if (rules.length > 0) loaded.push({ personId: row.id, rules });
  }
  return loaded;
}

/** What one mutation's notification evaluation produced. */
export interface NotificationOutcome {
  /** Recipients named by every rule that fired, de-duplicated, first-appearance order. */
  readonly recipients: readonly string[];
  /** How many rules fired across all people. */
  readonly firedCount: number;
  /**
   * Why nothing was evaluated, when that is the answer. `null` when
   * evaluation ran. `"disabled"` means `notify.doc` is unset — SCHEMA.md
   * §17.2's "null means notifications off".
   */
  readonly skipped: "disabled" | null;
  /** Set when evaluation threw. The mutation still succeeds — see the module header. */
  readonly error: string | null;
}

const NOTHING: NotificationOutcome = {
  recipients: [],
  firedCount: 0,
  skipped: null,
  error: null,
};

/**
 * Evaluates every stored rule against one mutation's before/after snapshot.
 *
 * `notifyDoc` is `ctx.settings.values["notify.doc"]`. When it is null the
 * capability is off and this returns without reading `people` at all — per
 * SCHEMA.md §17.2, and so that a fresh installation, where the setting
 * defaults to null, does not pay a query per mutation for a feature nobody
 * configured.
 *
 * Delivery is explicitly not here. SCHEMA.md §1.1b: "how a recipient is
 * reached is the configured `notify` capability — the core hands over a doc
 * path and never knows what the chat app is." This returns who to tell; the
 * doc path is the handover, and the capability that reads it is its own
 * concern.
 */
export async function evaluateNotifications(
  db: TransactionHandle,
  notifyDoc: string | null,
  before: FieldSnapshot,
  after: FieldSnapshot,
): Promise<NotificationOutcome> {
  if (notifyDoc === null) return { ...NOTHING, skipped: "disabled" };

  try {
    const people = await loadPersonRules(db);
    if (people.length === 0) return NOTHING;

    const recipients: string[] = [];
    const seen = new Set<string>();
    let firedCount = 0;

    for (const person of people) {
      const result = evaluateRules(person.rules, before, after);
      firedCount += result.fired.length;
      for (const who of result.recipients) {
        if (seen.has(who)) continue;
        seen.add(who);
        recipients.push(who);
      }
    }

    return { recipients, firedCount, skipped: null, error: null };
  } catch (cause) {
    // Contained on purpose — the module header explains why a bad rule must
    // not be able to make an unrelated item untransitionable.
    return { ...NOTHING, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
