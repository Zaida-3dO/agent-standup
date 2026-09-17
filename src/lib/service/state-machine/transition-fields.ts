// The closed set of keys `fields` accepts on a transition, and the refusal
// that names a key it does not. See docs/plans/MILESTONES.md #16, SCHEMA.md
// §16.
//
// ── Why this module exists ─────────────────────────────────────────────
//
// `transition_item` used to take `fields` as an open record and hand it
// straight to the guard layer, whose own doc comment promised it was
// "passed straight through unchanged". Every key a guard did not read was
// therefore discarded in silence, and the operation still answered
// `allowed: true`. A caller who wrote `fields: {mergeAuthority:
// "pre-approved"}` got a success back and no change to the item, in the
// same response — the write reported that it landed and it had not. The
// camelCase spellings of real keys (`blockedReason` for `blocked_reason`)
// failed the same way, except there the *guard* then refused for the
// snake_case field being absent, so the caller was told two contradictory
// things about one call.
//
// So the set is declared here, once, and a key outside it is refused by
// name before any guard runs.
//
// ── Why the guards read their key names from here ──────────────────────
//
// Declaring the accepted set in one module and reading it in another is
// only half an answer: a hand-kept list can fall behind the guards that
// consume it, and a key consumed but not declared would be refused at the
// door while a guard downstream still demanded it — the same contradiction
// in a new place. The guards therefore take their literal key names from
// `TRANSITION_FIELD` below, so a key cannot be consumed without being
// declared accepted.
//
// That is the pattern `COMPLETED_STATES` already uses one level up
// (`summaries/validate.ts` → `guards/summaries.ts:17` and
// `operations/complete-item.ts:30`), and for the same stated reason: it
// makes the disagreement unrepresentable rather than merely unlikely. The
// coupling points the safe way — consumption derives from declaration,
// never the reverse.
//
// ── What does NOT belong here ──────────────────────────────────────────
//
// A key that names a real column is not thereby a transition field.
// `mergeAuthority`, `needsVisualReview` and the rest are `update_item`'s to
// write, and `fields` carries no authorisation check of any kind — so
// accepting `mergeAuthority` here would be a route around the auth on the
// one field that decides whether a human authorised a merge. Such keys are
// refused with `update_item` named as the exit, not quietly applied.
import { InvalidInputError } from "../errors";

/**
 * A key `fields` accepts, and the conditions under which it means
 * anything.
 *
 * `appliesTo` is what makes a right-name-wrong-state refusal possible:
 * `blocked_reason` on a transition to `executing` is not a misspelling and
 * not garbage — it is a real key sent to a transition that has no use for
 * it, and saying so is a different sentence from "no such key".
 */
export interface TransitionFieldSpec {
  /** The accepted spelling. Always `snake_case`, matching SCHEMA.md §16. */
  readonly key: string;
  /**
   * The target states this key is read on. A transition to any other state
   * ignores it, so sending it there is refused rather than dropped.
   */
  readonly appliesTo: readonly string[];
  /**
   * Whether accepting the key writes an item column (`transition.ts`'s
   * `UPDATE`) or is only read by a guard while it decides.
   *
   * Recorded because the distinction is the whole reason the accepted set
   * is larger than the write site's six: deriving this table from the
   * `UPDATE` statement would drop `summary` and `merge_rationale`, and
   * dropping `summary` breaks the UI cancel button, which posts
   * `{to: "cancelled", fields: {summary}}` through the ordinary transition
   * route (`src/lib/item-detail/cancel-state.ts`).
   */
  readonly writesColumn: boolean;
  /** Which operations accept it — see `TransitionFieldOperation`. */
  readonly acceptedBy: readonly TransitionFieldOperation[];
}

/**
 * The operations that take a `fields` record.
 *
 * Acceptance is per-operation, not merely per-state, because the two
 * genuinely disagree about one key and are meant to. `complete_item`
 * refuses a caller-supplied `fields.summary`
 * (`operations/complete-item.ts`'s `.refine`) and then injects the
 * top-level `summary` into the same record before calling
 * `applyTransition` — so the guard still reads `fields.summary`, but the
 * caller may not be the one who put it there. A table keyed only on state
 * would either break that refusal or break the cancel path; it has to be
 * able to say "accepted on one, refused on the other".
 */
export type TransitionFieldOperation = "transition_item" | "complete_item";

/** Entering `blocked` — the four keys `blockedRequiredFieldsGuard` reads. */
const BLOCKED_STATES = ["blocked"] as const;
/** Entering `paused` — the two keys `pausedRequiredFieldsGuard` reads. */
const PAUSED_STATES = ["paused"] as const;
/**
 * The four completed states, spelled out rather than imported from
 * `summaries/validate.ts`.
 *
 * This is the one place in this module that does *not* derive, and it is
 * deliberate: `state-machine/` is imported by `summaries/validate.ts`'s
 * consumers rather than the other way round, and importing back the other
 * way makes a cycle. The list is asserted equal to `COMPLETED_STATES` in
 * `tests/transition-fields-accepted.test.ts`, so the duplication is checked rather
 * than trusted.
 */
const COMPLETED_STATES_FOR_SUMMARY = ["merged", "research_done", "wont_do", "cancelled"] as const;

const BOTH_OPERATIONS = ["transition_item", "complete_item"] as const;

/**
 * Every key `fields` accepts, on any operation, in any state.
 *
 * Eight. Six write a column; `summary` and `merge_rationale` write none and
 * are read by guards only. Derived from *guard consumption*, not from the
 * `UPDATE` statement — see `writesColumn` above for why that distinction is
 * load-bearing rather than trivia.
 */
export const TRANSITION_FIELDS: readonly TransitionFieldSpec[] = [
  {
    key: "blocked_reason",
    appliesTo: BLOCKED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "blocked_on_type",
    appliesTo: BLOCKED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "blocked_on_person",
    appliesTo: BLOCKED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "unblock_at",
    appliesTo: BLOCKED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "pause_reason",
    appliesTo: PAUSED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "resume_condition",
    appliesTo: PAUSED_STATES,
    writesColumn: true,
    acceptedBy: BOTH_OPERATIONS,
  },
  {
    key: "summary",
    appliesTo: COMPLETED_STATES_FOR_SUMMARY,
    writesColumn: false,
    // `transition_item` only. `complete_item` has a dedicated top-level
    // `summary` and refuses it here by name — the refusal predates this
    // table and is itself a correct example of what this table generalises,
    // so it is preserved rather than absorbed.
    acceptedBy: ["transition_item"],
  },
  {
    key: "merge_rationale",
    appliesTo: ["merged"],
    writesColumn: false,
    acceptedBy: BOTH_OPERATIONS,
  },
];

/** The accepted spellings, for a message that has to list them. */
export const TRANSITION_FIELD_KEYS: readonly string[] = TRANSITION_FIELDS.map((f) => f.key);

const BY_KEY: ReadonlyMap<string, TransitionFieldSpec> = new Map(
  TRANSITION_FIELDS.map((spec) => [spec.key, spec]),
);

/**
 * The literal key names, as named constants for the guards to read.
 *
 * A guard writes `TRANSITION_FIELD.blocked_reason` rather than the string
 * `"blocked_reason"`, so the key it consumes is by construction the key
 * this table declares accepted. Typed as the literal strings, not `string`,
 * so a typo here is a compile error rather than a guard that silently reads
 * a key nobody can send.
 */
export const TRANSITION_FIELD = {
  blocked_reason: "blocked_reason",
  blocked_on_type: "blocked_on_type",
  blocked_on_person: "blocked_on_person",
  unblock_at: "unblock_at",
  pause_reason: "pause_reason",
  resume_condition: "resume_condition",
  summary: "summary",
  merge_rationale: "merge_rationale",
} as const satisfies Record<string, string>;

/**
 * Columns a caller may plausibly try to set through `fields`, and the call
 * that actually sets each one.
 *
 * These get a remedy naming `update_item` rather than a bare "not
 * accepted", because the caller's intent is legible and the field is real —
 * it is simply not this operation's to write. `mergeAuthority` is the
 * reported case (a `transition_item` that answered `allowed: true` and
 * changed nothing), and it is also the one where quietly applying it would
 * have been a privilege escalation.
 *
 * The values are the spellings `update_item` **accepts**, which for
 * `mergeAuthority` means the hyphenated enum member: `update-item.ts`'s
 * schema is `z.enum(["pre-approved", "needs-approval", "agent-judgement",
 * "pr"])` and maps to the underscored DB form internally — `pr` being the
 * one member whose two spellings coincide, as it has no hyphen. A remedy naming
 * `pre_approved` would be advice the operation refuses — the
 * unreachable-remedy defect this whole item exists to remove, and one the
 * advice lint fails the build over.
 */
const UPDATE_ITEM_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["mergeAuthority", 'update_item {mergeAuthority: "pre-approved"}'],
  ["merge_authority", 'update_item {mergeAuthority: "pre-approved"}'],
  ["needsVisualReview", "update_item {needsVisualReview: false}"],
  ["needs_visual_review", "update_item {needsVisualReview: false}"],
  ["priority", 'update_item {priority: "high"}'],
  ["headline", "update_item {headline: ...}"],
  ["title", "update_item {title: ...}"],
  ["body", "update_item {body: ...}"],
  ["assignee", "update_item {assignee: ...}"],
  ["area", "update_item {area: ...}"],
  ["repo", "update_item {repo: ...}"],
  ["branch", "update_item {branch: ...}"],
]);

/**
 * A supplied key reduced to the form a near-miss comparison uses:
 * lowercased with `_` stripped.
 *
 * That is what makes `blockedReason`, `BlockedReason` and `blocked__reason`
 * all land on `blocked_reason`, and — the case actually reported —
 * `unblockAT` on `unblock_at`. Deliberately not a general edit-distance
 * match: a suggestion is only offered when the caller demonstrably spelled
 * the *same* key a different way, because "did you mean X?" pointed at a
 * key the caller was not reaching for is worse than no suggestion.
 */
function normalise(key: string): string {
  return key.toLowerCase().replaceAll("_", "");
}

const BY_NORMALISED: ReadonlyMap<string, string> = new Map(
  TRANSITION_FIELDS.map((spec) => [normalise(spec.key), spec.key]),
);

/** Why a supplied key was refused, and what the caller should do instead. */
export interface RejectedTransitionField {
  /** The key exactly as the caller spelled it. */
  readonly supplied: string;
  /**
   * The refusal, as one sentence naming the exit that applies to this
   * key — a different sentence per class, never a generic "invalid field".
   */
  readonly message: string;
}

/**
 * Every key in `fields` that `operation` will not act on, in the order the
 * caller supplied them.
 *
 * Empty means every key is accepted and applies. **All** offenders are
 * returned rather than the first, so a caller with two mistyped keys learns
 * both in one round trip — the convention `blockedRefusalMessage` already
 * set with "supply them together — this will not be accepted one field at a
 * time".
 */
export function findRejectedTransitionFields(
  fields: Readonly<Record<string, unknown>> | undefined,
  to: string,
  operation: TransitionFieldOperation,
): readonly RejectedTransitionField[] {
  if (fields === undefined) return [];
  const rejected: RejectedTransitionField[] = [];

  for (const supplied of Object.keys(fields)) {
    const spec = BY_KEY.get(supplied);

    if (spec !== undefined && spec.acceptedBy.includes(operation) && spec.appliesTo.includes(to)) {
      continue;
    }

    rejected.push({ supplied, message: refusalFor(supplied, spec, to, operation) });
  }

  return rejected;
}

/**
 * The one sentence for one rejected key.
 *
 * Four classes, most specific first. The ordering matters: a key that is a
 * real accepted spelling must never be told it does not exist just because
 * this transition has no use for it, and a key that names a real column
 * must be sent to the operation that writes it rather than being called
 * garbage.
 */
function refusalFor(
  supplied: string,
  spec: TransitionFieldSpec | undefined,
  to: string,
  operation: TransitionFieldOperation,
): string {
  // 1. Right name, wrong operation. Only `summary` on `complete_item`
  //    reaches this, and it keeps its established wording verbatim — that
  //    message is already the behaviour this table generalises, and callers
  //    and tests both know it.
  if (spec !== undefined && !spec.acceptedBy.includes(operation)) {
    return (
      `\`fields.${supplied}\` is not allowed on ${operation} — ` +
      `pass the summary in the top-level \`summary\` field.`
    );
  }

  // 2. Right name, wrong state. Name where it *does* apply and where this
  //    call is actually going; do not claim the key does not exist.
  if (spec !== undefined) {
    const where =
      spec.appliesTo.length === 1
        ? `entering \`${spec.appliesTo[0]}\``
        : `entering ${spec.appliesTo.map((s) => `\`${s}\``).join(", ")}`;
    return (
      `\`${supplied}\` applies only when ${where}; this transition targets \`${to}\`. ` +
      `Remove it, or send it on the transition that enters that state.`
    );
  }

  // 3. A real column, sent to the wrong operation. `fields` carries the
  //    target state's guard inputs and nothing else — it is not a general
  //    item editor, and it runs no authorisation check, which is why
  //    `mergeAuthority` in particular must go through `update_item`.
  const viaUpdate = UPDATE_ITEM_COLUMNS.get(supplied);
  if (viaUpdate !== undefined) {
    return (
      `\`fields\` on a transition carries only what the target state's guards require, ` +
      `and \`${supplied}\` is not one of them — set it with \`${viaUpdate}\` instead.`
    );
  }

  // 4. A near-miss on an accepted spelling. Every key here is `snake_case`,
  //    and camelCase was the reported mistake, so this is the common one.
  const meant = BY_NORMALISED.get(normalise(supplied));
  if (meant !== undefined) {
    return `\`${supplied}\` is not accepted here — did you mean \`${meant}\`?`;
  }

  // 5. Nothing recognisable. List what there is; the set is small enough to
  //    print, and a caller who guessed wrong twice needs the actual answer
  //    rather than a third guess.
  return (
    `\`${supplied}\` is not a field this transition accepts. ` +
    `\`fields\` takes only what the target state's guards require: ` +
    `${TRANSITION_FIELD_KEYS.map((k) => `\`${k}\``).join(", ")}.`
  );
}

/**
 * The whole refusal, when at least one key was rejected.
 *
 * One message naming every offender, for the reason `blockedRefusalMessage`
 * gives: a caller fixing fields one round trip at a time is the failure
 * mode, not a cosmetic inconvenience.
 */
export function rejectedTransitionFieldsMessage(
  rejected: readonly RejectedTransitionField[],
): string {
  const head =
    rejected.length === 1
      ? "This call supplied a field the transition does not accept, so it was refused rather " +
        "than ignored:"
      : `This call supplied ${rejected.length} fields the transition does not accept, so it was ` +
        `refused rather than ignoring them:`;
  return `${head} ${rejected.map((r) => r.message).join(" ")}`;
}

/**
 * Refuses the call when `fields` carries anything the operation will not
 * act on.
 *
 * `invalid_input` rather than `guard_rejected`, deliberately. A guard
 * rejection says the item is not in a fit state for the move and names what
 * to go and do about the *item*; this says the request itself is malformed
 * and names what to change about the *call*. They are different faults with
 * different remedies, and a caller that retries on one should not retry on
 * the other. It is also decided before any guard runs, so there is no guard
 * id to attribute it to — `GuardRejectedError` requires one precisely so
 * that §22's coverage assertion stays satisfiable, and inventing one here
 * would put a rule in that ledger that is not a rule.
 *
 * `fields` on the error carries the offending keys **as the caller spelled
 * them**, not the accepted spellings: it is the list of things to go and
 * fix in the request that was sent, and echoing back a corrected spelling
 * the caller never wrote would make the pointer land nowhere.
 */
export function assertTransitionFieldsAccepted(
  fields: Readonly<Record<string, unknown>> | undefined,
  to: string,
  operation: TransitionFieldOperation,
): void {
  const rejected = findRejectedTransitionFields(fields, to, operation);
  if (rejected.length === 0) return;
  throw new InvalidInputError(rejectedTransitionFieldsMessage(rejected), {
    fields: rejected.map((r) => r.supplied),
  });
}
