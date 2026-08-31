// Summaries — static validators. SCHEMA.md §5, §5a; MILESTONES.md #21.
//
// Everything here is pure and synchronous except the similarity check, which
// needs the item's prior `events` rows to compare against (SCHEMA.md §5,
// static validator 2: "No entry >=85% similar to any events row for this
// item"). The shape/caps/jargon validators need nothing from the database,
// so they are kept separable from the guard that wires them into a
// transition (`guard.ts`, same directory) — a caller with just a candidate
// summary and no open transaction can still run them.
//
// **Reject, never truncate** (SCHEMA.md §5, static validator 1). Every
// violation this module finds is returned as a `SummaryValidationIssue`; the
// caller (the guard) turns that into a `GuardRejectedError`. Nothing in this
// file ever shortens a string to make it fit — the caller either gets the
// value it submitted, unmodified, or a rejection naming which field and rule
// failed.

/** One `shipped` outcome, or one `not_done` follow-up-reason target — kept a plain string cap. */
export const SHIPPED_MIN = 1;
export const SHIPPED_MAX = 5;
export const SHIPPED_CHAR_CAP = 120; // SCHEMA.md §5: "1-5 entries, <=120 chars each."

/**
 * The terminal states whose summary must carry `shipped` — the ones that
 * assert work was delivered.
 *
 * `merged` is the obvious member. `research_done` is the less obvious one
 * and belongs here for the same reason: it closes an investigation that
 * *produced* something — findings, a recommendation, a ruled-out approach —
 * and those are outcomes a reader wants listed. Nothing about it is a
 * non-delivery.
 */
export const DELIVERY_STATES = ["merged", "research_done"] as const;

/**
 * The terminal states that assert the *opposite* of delivery, and therefore
 * require a `decision` instead of `shipped` (see `DECISION_CHAR_MIN`).
 *
 * ── Why this split exists at all ────────────────────────────────────────
 *
 * Requiring `shipped` for every completed state would force a caller closing
 * a duplicate row to write a non-delivery into a field named for delivered
 * work — *"identified as a duplicate of the open-loop writes row"* listed as
 * something that shipped, when nothing shipped at all.
 *
 * That is a worse failure than an awkward field name. Every other check in
 * this module exists to make the closing summary a *truthful record*: the
 * similarity check kills the log-paste, the jargon list keeps it readable by
 * someone who did not build it, `how_verified` may not be a bare CI
 * reference. A rule that forces a false-ish statement in order to close a
 * truthful state teaches the opposite lesson — that the summary is a
 * formality to satisfy rather than a record to get right — and it teaches it
 * at exactly the moment a caller is deciding how much care the whole
 * structure deserves. One field that must be lied into is enough to make
 * every neighbouring field feel optional.
 *
 * ── Why these states get a required `decision` and not simply nothing ────
 *
 * Dropping the requirement entirely was the smaller change and is the wrong
 * one. `wont_do` and `cancelled` are not the absence of an outcome; they
 * *are* an outcome — "this was wanted, considered, and deliberately not
 * done" (SCHEMA.md §1.4, which draws precisely this line to explain why
 * `delete_item` exists separately). The fact worth recording is the
 * reasoning, and it is the one fact nobody can reconstruct later: a closed
 * row with no reason is indistinguishable from an abandoned one, which is
 * the confusion `delete_item` already refuses to create.
 *
 * So the obligation is not removed, it is *pointed at the true thing*. The
 * shape is taken from `delete_item`'s archive reason rather than invented:
 * a required free-text field with a minimum length, refused when it is short
 * enough to be a shrug.
 */
export const NON_DELIVERY_STATES = ["wont_do", "cancelled"] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type NonDeliveryState = (typeof NON_DELIVERY_STATES)[number];

/** Every completed state, in one place — the union the two lists above partition. */
export const COMPLETED_STATES = [...DELIVERY_STATES, ...NON_DELIVERY_STATES] as const;
export type CompletedState = (typeof COMPLETED_STATES)[number];

/** True when `state` is a completed state that asserts delivery, so `shipped` is required. */
export function isDeliveryState(state: string): boolean {
  return (DELIVERY_STATES as readonly string[]).includes(state);
}

/** True when `state` is a completed state that asserts non-delivery, so `decision` is required. */
export function isNonDeliveryState(state: string): boolean {
  return (NON_DELIVERY_STATES as readonly string[]).includes(state);
}

/**
 * The shortest `decision` accepted, and the cap it may not exceed.
 *
 * The floor is 20, the same number and the same reasoning as
 * `delete_item`'s `ARCHIVE_REASON_MIN_CHARS`: long enough that "dupe",
 * "n/a" and "wont fix" do not clear it, short enough that "duplicate of
 * the open-loop writes row" does. The point is not the character count —
 * it is that a caller has to name *which* duplicate or *which* change of
 * plan, which is the sentence that makes the closure reviewable later.
 *
 * Deliberately the same floor rather than an independently-chosen one:
 * these two refusals ask a caller for the same kind of sentence at the same
 * kind of moment, and two different minimum lengths for "name the reason"
 * would be a difference with no meaning behind it.
 */
export const DECISION_CHAR_MIN = 20;
export const DECISION_CHAR_CAP = 240;

export const NOT_DONE_MIN = 0;
export const NOT_DONE_MAX = 5; // SCHEMA.md §5: "0-5 typed entries."
// SCHEMA.md §5a does not state a per-field character cap for `not_done`'s
// `text`/`reason` strings — the row only bounds entry *count* (0-5).
// DECISIONS.md's "Closing summaries" note says only "typed fields with hard
// caps" in the aggregate, and does not restate one either. Per the task
// brief, a cap was lost from this field somewhere in an earlier audit of the
// source doc; it is not recoverable from either document as they stand. This
// is my own placeholder, not a spec'd value — generous enough not to bite a
// real deferral note, applied so "reject, never truncate" has something
// concrete to enforce on this field too. Flagged in the PR/handoff; a future
// row should replace it the moment the real cap is confirmed or restored.
export const NOT_DONE_TEXT_CHAR_CAP = 240;
/**
 * The closed set of typed reasons a `not_done` entry may carry — SCHEMA.md
 * §5a. Each one names a *different claim about the world*, and each is paired
 * with a proof obligation that only holds when that claim is true
 * (`guards/deferral.ts`). That pairing is the whole mechanism: the standard
 * "the explanation must be good enough" is ungradeable as prose, so §5a
 * inverts it into something a query can check.
 *
 *   - `follow-up`           — deferred because something is in the way. Proved
 *                             by a linked item that is genuinely `blocked` or
 *                             `paused`.
 *   - `follow-up-scheduled` — NOT deferred: separate work, already committed
 *                             to as its own queue row. Proved by a linked item
 *                             that is open, actionable, and a **sibling**
 *                             rather than a descendant (DECISIONS.md §17).
 *   - `needs-approval`      — waiting on a person. Proved by a linked item
 *                             `blocked` with `blocked_on_type = person`.
 *   - `descoped`            — a decision not to do it. No work is deferred, so
 *                             there is nothing to point at.
 *
 * **What adding a fourth reason costs, stated as a trade rather than as a
 * free win.** §5a's load-bearing property is that *"ran out of time"*, *"too
 * hard"* and *"will do later"* have no reason code and therefore cannot be
 * said. Mutual exclusivity between the two follow-up reasons is not by itself
 * enough to preserve that: the question is not whether they overlap but
 * whether their *union* now covers "later". So the price is charged
 * explicitly. `follow-up` charges it by requiring the linked item to be
 * `blocked` or `paused` — and `blocked` demands a reason and a
 * `blocked_on_type`, so faking one makes the work MORE visible.
 * `follow-up-scheduled` charges it by requiring the linked item to be
 * genuinely scheduled: `someday` is refused (`guards/deferral.ts`'s
 * `UNSCHEDULED_ITEM_STATES`), because it is the one state that means
 * *unscheduled* — accepting it would make the reason's own name false.
 *
 * **The two prices are not equal, and the difference is recorded rather than
 * smoothed over.** A false `blocked` costs a reason, a `blocked_on_type`, and
 * a place on somebody's needs-you list. Refusing `someday` costs a positive
 * assertion that the work is queued — real, because it is a claim someone can
 * disagree with and it sits in a permanent record, but lighter, since a
 * freshly minted item is already in an accepted state. See
 * `UNSCHEDULED_ITEM_STATES` for the full accounting.
 *
 * **The honest comparison is not against a perfect §5a, though.** The shape
 * this reason exists for — a review's non-blocking finding, recorded as an
 * open sibling — had no representation at all, and the observed response was
 * to drop `not_done` and put the deferral in `watch_for` as prose. That path
 * costs nothing and requires no false statement either, and it destroys the
 * machine-readable link. Measured against that, a priced, checkable,
 * *linked* path is a gain. Measured against the ideal, it is a widening, and
 * it is written down here as one so the next reader is not told a property
 * holds more completely than it does.
 */
export const NOT_DONE_REASONS = [
  "follow-up",
  "follow-up-scheduled",
  "needs-approval",
  "descoped",
] as const;
export type NotDoneReason = (typeof NOT_DONE_REASONS)[number];

export const WHAT_TO_TEST_MIN = 1;
export const WHAT_TO_TEST_MAX = 3; // SCHEMA.md §5: "Required iff user_facing. 1-3 entries."
// No char cap stated in SCHEMA for `what_to_test[].text`. Same posture as
// `not_done` above: my own placeholder, not a spec'd value.
export const WHAT_TO_TEST_TEXT_CHAR_CAP = 240;

export const WATCH_FOR_MAX = 3; // SCHEMA.md §5: "0-3."
// No char cap stated for `watch_for` entries either. Own placeholder.
export const WATCH_FOR_CHAR_CAP = 240;

// No char cap stated for `how_verified` (a single string, not an array).
// Own placeholder — generous, since it is meant to hold "what was run and
// observed live," which can legitimately run longer than a one-line outcome.
export const HOW_VERIFIED_CHAR_CAP = 600;

/** The similarity threshold SCHEMA.md §5 states outright: ">=85% similar" is a rejection. */
export const SIMILARITY_REJECT_AT = 0.85;

/**
 * The jargon denylist (SCHEMA.md §5, static validator 3): "the vocabulary of
 * the system rather than of the work" — internal command names, raw field
 * identifiers, review shorthand, bare cross-references, script filenames,
 * ALL-CAPS prefixes. Each entry is matched case-sensitively against the
 * *token* boundaries described alongside it below (`findJargonHits`) —
 * plain strings here, no regex authoring at the call site, so every entry
 * reads as a term rather than a pattern.
 *
 * Kept deliberately plain: every entry below names this project's own
 * internal vocabulary as it exists right now — an enum value, a review
 * shorthand convention, an identifier-assignment syntax, a script-file
 * extension this project actually uses. None of it points outside this
 * repository or refers to anything this repository is not.
 */
export const JARGON_TERMS: readonly string[] = [
  // Raw field identifiers / assignment syntax.
  "owner=",
  "review_round",
  "blocked_reason",
  "blocked_on_type",
  "merge_authority",
  "drive_mode",
  // Review shorthand.
  "LGTM",
  "fail-open",
  "fail-closed",
  // Script filenames — the extension this project's own scripts use
  // (`scripts/*.mjs`), not a fixed real filename.
  ".mjs",
];

/** A bare `#123`, `PR-123`, or `§12`-style cross-reference — matched structurally, not as a fixed string. */
const CROSS_REFERENCE = /(^|[\s(])(#\d+|PR-\d+|§\d+(\.\d+)?[a-z]?)\b/;

/**
 * The ALL-CAPS-prefix conventions this denylist actually means to catch —
 * an enumerated list (review round 1, MEDIUM), not a blanket
 * `\b[A-Z]{2,}[:_]/` pattern.
 *
 * The blanket regex fired on any two-or-more uppercase letters followed by
 * `:` or `_` — which also matches legitimate technical prefixes that happen
 * to be all-caps abbreviations: `DB:`, `URL:`, `SQL:`, `NB:`, `OK:`. Those
 * are plausible, ordinary `how_verified` prose ("DB: migrations applied
 * cleanly"); rejecting them blocks a legitimate completion for a reason the
 * author cannot see. The rule SCHEMA.md §5 actually describes is "ALL-CAPS
 * prefixes" in the sense of annotation shorthand a writer drops into a
 * comment or commit message — not every acronym that happens to be
 * upper-case. Enumerating the real set is precise and asks for nothing this
 * matcher cannot already do; it costs maintenance (a new prefix convention
 * needs a line added here), which is the trade the option to keep the
 * blanket regex plus an allowlist would avoid — but that alternative means
 * guessing at the complement of an infinite set of legitimate technical
 * prefixes, which is the wrong side of that trade to be guessing on.
 */
export const ALL_CAPS_PREFIXES: readonly string[] = [
  "TODO",
  "FIXME",
  "WIP",
  "HACK",
  "XXX",
  "NOTE",
  "BUG",
];

/** Matches one of `ALL_CAPS_PREFIXES` at a word boundary, immediately followed by `:` or `_`. */
const ALL_CAPS_PREFIX = new RegExp(`\\b(${ALL_CAPS_PREFIXES.join("|")})[:_]`);

export interface SummaryValidationIssue {
  readonly field: string;
  readonly rule: string;
  readonly message: string;
}

export interface NotDoneEntry {
  readonly text: string;
  readonly reason: string;
  readonly item_id?: string;
}

export interface WhatToTestEntry {
  readonly text: string;
  readonly link?: string;
}

/** The candidate shape a caller submits for validation — SCHEMA.md §5's authored fields only; `final_state` is derived and never validated here. */
export interface SummaryCandidate {
  readonly shipped: readonly string[];
  readonly not_done: readonly NotDoneEntry[];
  readonly user_facing: boolean;
  readonly what_to_test?: readonly WhatToTestEntry[] | null;
  readonly how_verified?: string | null;
  readonly watch_for: readonly string[];
  /**
   * Why the work is not being done — required for `wont_do` and `cancelled`,
   * refused for the delivery states. See `NON_DELIVERY_STATES`.
   */
  readonly decision?: string | null;
}

/**
 * The terminal state this summary is being written for.
 *
 * Passed to the validator rather than inferred, because `shipped` and
 * `decision` are required in opposite cases and neither can be decided from
 * the summary's own contents — a caller who omitted both is making a
 * different mistake depending on where they are going.
 *
 * `undefined` means "state not supplied", and is treated as the delivery
 * case: that is the pre-existing behaviour every caller not passing a state
 * already relies on, and it is the conservative direction — an unknown
 * destination keeps the stricter `shipped` requirement rather than silently
 * accepting a summary that asserts nothing.
 */
export type SummaryTargetState = string | undefined;

function pushIfTooLong(
  issues: SummaryValidationIssue[],
  field: string,
  index: number | undefined,
  value: string,
  cap: number,
): void {
  if (value.length > cap) {
    const label = index === undefined ? field : `${field}[${index}]`;
    issues.push({
      field,
      rule: "max_length",
      message: `${label} is ${value.length} characters, over the ${cap}-character cap. Shorten it and resubmit — it will not be truncated for you.`,
    });
  }
}

/**
 * A surviving entry paired with the index it occupied in the array the
 * caller actually sent.
 *
 * The index is carried rather than recomputed because the surviving list is
 * *compacted*: malformed entries are dropped from it. Labelling a later
 * complaint with its position in the compacted list would name an index the
 * caller never sent that value at — see `SanitisedEntries`.
 */
interface IndexedEntry<T> {
  readonly index: number;
  readonly value: T;
}

/**
 * The well-formed subset of a candidate's list fields — what the checks in
 * `validateSummaryShape` are safe to read `.text` and `.length` off.
 *
 * Separate from `SummaryCandidate` because that type describes what a
 * caller is *supposed* to send, while this describes what actually survived
 * inspection.
 *
 * Entries are index-paired rather than bare. These lists are compacted, so
 * a bare list would renumber everything after a dropped entry, and every
 * subsequent complaint would name an index shifted down by the number of
 * malformed entries before it — reporting `shipped[0] is 5000 characters`
 * for a value the caller sent at `shipped[1]`, while the entry genuinely at
 * index 0 drew a *different* complaint. Two contradictory messages about
 * one index, and silence about the real offender.
 */
interface SanitisedEntries {
  readonly shipped: readonly IndexedEntry<string>[];
  readonly not_done: readonly IndexedEntry<NotDoneEntry>[];
  readonly what_to_test: readonly IndexedEntry<WhatToTestEntry>[];
  readonly watch_for: readonly IndexedEntry<string>[];
}

/**
 * The expected-shape sentence for an entry field, written for a caller who
 * just sent the wrong one.
 *
 * States the shape positively and shows it, because a caller who reached
 * this message needs something concrete to act on: the two typed-entry
 * fields (`not_done`, `what_to_test`) are objects whose `text` carries the
 * prose, and it is genuinely easy to assume they are bare strings like
 * `shipped` and `watch_for` are.
 */
export const ENTRY_SHAPE_HINTS: Readonly<Record<string, string>> = {
  shipped: "a string",
  watch_for: "a string",
  not_done: 'an object like {"text": "...", "reason": "descoped"}',
  what_to_test: 'an object like {"text": "..."}',
};

function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Checks that every entry in the four list fields is the shape its field
 * requires, recording a named issue for each that is not, and returns only
 * the entries that are.
 *
 * A string field's entry must be a string; a typed field's entry must be an
 * object carrying a string `text`. `reason` is deliberately *not* checked
 * here — an object with a bad `reason` is well-formed enough to read, and
 * the existing `not_done` reason check below produces a better message for
 * it than a generic shape complaint would.
 *
 * Survivors come back paired with the index they were sent at, so that the
 * length and jargon checks downstream can name the caller's own index
 * rather than a position in the compacted list.
 */
function collectEntryShapeIssues(
  candidate: SummaryCandidate,
  issues: SummaryValidationIssue[],
): SanitisedEntries {
  function keepStrings(
    field: "shipped" | "watch_for",
    entries: readonly unknown[],
  ): IndexedEntry<string>[] {
    const kept: IndexedEntry<string>[] = [];
    entries.forEach((entry, i) => {
      if (typeof entry === "string") {
        kept.push({ index: i, value: entry });
        return;
      }
      issues.push({
        field,
        rule: "entry_shape",
        message: `${field}[${i}] must be ${ENTRY_SHAPE_HINTS[field]}; got ${describeReceived(entry)}.`,
      });
    });
    return kept;
  }

  function keepTyped<T>(
    field: "not_done" | "what_to_test",
    entries: readonly unknown[],
  ): IndexedEntry<T>[] {
    const kept: IndexedEntry<T>[] = [];
    entries.forEach((entry, i) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as { text?: unknown }).text === "string"
      ) {
        kept.push({ index: i, value: entry as T });
        return;
      }
      // A string entry is called out separately: it is by far the most
      // likely mistake here, and "got a string" alone does not tell a
      // caller that the text they sent is the right *content* in the wrong
      // wrapper. Saying so turns the fix into moving one value.
      const received =
        typeof entry === "string"
          ? "a string — wrap it as the object's text field"
          : describeReceived(entry);
      issues.push({
        field,
        rule: "entry_shape",
        message: `${field}[${i}] must be ${ENTRY_SHAPE_HINTS[field]}; got ${received}.`,
      });
    });
    return kept;
  }

  return {
    shipped: keepStrings("shipped", candidate.shipped ?? []),
    watch_for: keepStrings("watch_for", candidate.watch_for ?? []),
    not_done: keepTyped<NotDoneEntry>("not_done", candidate.not_done ?? []),
    what_to_test: keepTyped<WhatToTestEntry>("what_to_test", candidate.what_to_test ?? []),
  };
}

/**
 * Validates shape, counts and per-field caps (SCHEMA.md §5's static
 * validator 1) plus the conditional `user_facing` selects between (§5 —
 * `what_to_test` when true, `how_verified` when false) and the jargon
 * denylist on human-facing fields
 * (static validator 3) and the `how_verified`-not-CI-only rule (static
 * validator 4).
 *
 * Deliberately does **not** run the similarity check (static validator 2) —
 * that needs the item's event history, which only the guard (with a
 * transaction handle) can fetch. Kept as a separate function
 * (`findSimilarityIssues`, below) so a caller with no database access can
 * still run every check this function covers.
 *
 * Returns every issue found rather than stopping at the first — a caller
 * fixing a rejected summary wants the whole list in one round, not one
 * violation at a time.
 */
export function validateSummaryShape(
  candidate: SummaryCandidate,
  to?: SummaryTargetState,
): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];
  const nonDelivery = to !== undefined && isNonDeliveryState(to);

  // --- entry shape, before anything reads `.text`/`.length` off an entry ---
  //
  // `SummaryCandidate` is a *claim* about shape, not a proof of one. The
  // guard path builds it in `readCandidate` (`guards/summaries.ts`) from
  // `fields.summary`, which `transition_item` passes through unvalidated by
  // design (SCHEMA.md §16 — the operation "does not interpret them"), and
  // that builder only checks `Array.isArray`: an array of plain strings
  // where entries are objects satisfies it and is then *cast* to
  // `WhatToTestEntry[]`. Every check below would read `.text` off a string
  // and get `undefined`, and `pushIfTooLong`'s `value.length` would throw a
  // `TypeError` — which escapes as an `internal` service error carrying an
  // empty `fields` array, the one refusal shape a caller cannot act on
  // because it cannot distinguish bad input from a broken server.
  //
  // So malformed entries are rejected *by name* here and then excluded from
  // the checks below. Excluding them matters as much as naming them: a
  // caller gets the shape complaint plus every genuine issue in the rest of
  // the summary in one round, instead of a shape complaint followed by a
  // crash on the next line.
  const sanitised = collectEntryShapeIssues(candidate, issues);

  // --- shipped / decision: which one is required is decided by `to` ---
  //
  // The two branches are exclusive in both directions. A `wont_do` close
  // must not be able to *also* claim delivery, or the field this split
  // exists to keep honest is back in play through a side door; and a
  // `merged` close must not be able to substitute a reason for a list of
  // outcomes.
  if (nonDelivery) {
    const decision = candidate.decision;
    if (decision === null || decision === undefined || decision.trim().length === 0) {
      issues.push({
        field: "decision",
        rule: "required",
        message:
          `Closing as ${to} needs a decision: one or two sentences on why this work is not ` +
          `being done. Nothing shipped, so shipped is not required and must be empty — say ` +
          `what was decided instead.`,
      });
    } else {
      if (decision.trim().length < DECISION_CHAR_MIN) {
        issues.push({
          field: "decision",
          rule: "min_length",
          message:
            `decision is ${decision.trim().length} characters, under the ` +
            `${DECISION_CHAR_MIN}-character floor. Name which duplicate, or what changed — ` +
            `a reader six months from now cannot reconstruct it from the row alone.`,
        });
      }
      pushIfTooLong(issues, "decision", undefined, decision, DECISION_CHAR_CAP);
      issues.push(...findJargonHits("decision", undefined, decision));
    }
    if (candidate.shipped.length > 0) {
      issues.push({
        field: "shipped",
        rule: "not_applicable",
        message:
          `shipped must be empty when closing as ${to} — nothing was delivered. Put the ` +
          `reasoning in decision instead.`,
      });
    }
  } else {
    if (candidate.shipped.length < SHIPPED_MIN || candidate.shipped.length > SHIPPED_MAX) {
      issues.push({
        field: "shipped",
        rule: "count",
        message: `shipped must have ${SHIPPED_MIN}-${SHIPPED_MAX} entries; got ${candidate.shipped.length}.`,
      });
    }
    if (candidate.decision !== null && candidate.decision !== undefined) {
      issues.push({
        field: "decision",
        rule: "not_applicable",
        message:
          "decision applies only when closing as wont_do or cancelled — for a completion that " +
          "delivered something, list the outcomes in shipped.",
      });
    }
  }
  sanitised.shipped.forEach(({ index, value }) => {
    pushIfTooLong(issues, "shipped", index, value, SHIPPED_CHAR_CAP);
    issues.push(...findJargonHits("shipped", index, value));
  });

  // --- not_done: 0-5 typed entries, each with a recognised reason ---
  if (candidate.not_done.length > NOT_DONE_MAX) {
    issues.push({
      field: "not_done",
      rule: "count",
      message: `not_done must have at most ${NOT_DONE_MAX} entries; got ${candidate.not_done.length}.`,
    });
  }
  sanitised.not_done.forEach(({ index, value: entry }) => {
    pushIfTooLong(issues, "not_done", index, entry.text, NOT_DONE_TEXT_CHAR_CAP);
    issues.push(...findJargonHits("not_done", index, entry.text));
    if (!NOT_DONE_REASONS.includes(entry.reason as NotDoneReason)) {
      issues.push({
        field: "not_done",
        rule: "reason",
        message: `not_done[${index}].reason must be one of ${NOT_DONE_REASONS.join(", ")}; got ${JSON.stringify(entry.reason)}.`,
      });
    }
  });

  // --- user_facing selects between what_to_test and how_verified (SCHEMA.md §5) ---
  if (candidate.user_facing) {
    const steps = candidate.what_to_test ?? [];
    if (steps.length < WHAT_TO_TEST_MIN || steps.length > WHAT_TO_TEST_MAX) {
      issues.push({
        field: "what_to_test",
        rule: "count",
        message: `what_to_test is required when user_facing is true, with ${WHAT_TO_TEST_MIN}-${WHAT_TO_TEST_MAX} entries; got ${steps.length}.`,
      });
    }
    // Counted above on the submitted array, but read here off the
    // well-formed subset: a malformed entry still counts toward the
    // cardinality it was submitted as (dropping it would turn one mistake
    // into a spurious second "too few entries" complaint), while only
    // entries that actually carry a `text` are dereferenced.
    sanitised.what_to_test.forEach(({ index, value: step }) => {
      pushIfTooLong(issues, "what_to_test", index, step.text, WHAT_TO_TEST_TEXT_CHAR_CAP);
      issues.push(...findJargonHits("what_to_test", index, step.text));
    });
    if (candidate.how_verified !== null && candidate.how_verified !== undefined) {
      issues.push({
        field: "how_verified",
        rule: "not_applicable",
        message:
          "how_verified must be omitted when user_facing is true — use what_to_test instead.",
      });
    }
  } else {
    if (!candidate.how_verified || candidate.how_verified.trim().length === 0) {
      issues.push({
        field: "how_verified",
        rule: "required",
        message: "how_verified is required when user_facing is false.",
      });
    } else {
      pushIfTooLong(
        issues,
        "how_verified",
        undefined,
        candidate.how_verified,
        HOW_VERIFIED_CHAR_CAP,
      );
      issues.push(...findJargonHits("how_verified", undefined, candidate.how_verified));
      if (isCiReferenceOnly(candidate.how_verified)) {
        issues.push({
          field: "how_verified",
          rule: "ci_only",
          message:
            "how_verified may not consist solely of a CI/test-run reference — say what was run and observed live.",
        });
      }
    }
    if (candidate.what_to_test !== null && candidate.what_to_test !== undefined) {
      issues.push({
        field: "what_to_test",
        rule: "not_applicable",
        message:
          "what_to_test must be omitted when user_facing is false — use how_verified instead.",
      });
    }
  }

  // --- watch_for: 0-3 ---
  if (candidate.watch_for.length > WATCH_FOR_MAX) {
    issues.push({
      field: "watch_for",
      rule: "count",
      message: `watch_for must have at most ${WATCH_FOR_MAX} entries; got ${candidate.watch_for.length}.`,
    });
  }
  sanitised.watch_for.forEach(({ index, value }) => {
    pushIfTooLong(issues, "watch_for", index, value, WATCH_FOR_CHAR_CAP);
    issues.push(...findJargonHits("watch_for", index, value));
  });

  return issues;
}

/**
 * `how_verified` "may not consist *solely* of a CI/test reference" (SCHEMA.md
 * §5, static validator 4). Matched as: after stripping a single CI/test-run
 * phrase and surrounding punctuation, nothing but whitespace remains — so
 * "ran the suite, all green" (extra words) passes, and "tests pass" or "CI
 * green" (nothing else) is refused.
 */
const CI_ONLY_PHRASES =
  /\b(ci|tests?|test suite|the suite|build)\s+(pass(ed|es)?|green|ok|succeeded)\b/gi;

function isCiReferenceOnly(text: string): boolean {
  const stripped = text.replace(CI_ONLY_PHRASES, "").replace(/[.,;:!\s]+/g, "");
  return stripped.length === 0;
}

/**
 * Finds jargon-denylist hits in `text` for one field/index.
 *
 * Exported (not just used internally) so the guard and its tests can probe
 * this in isolation from the count/cap rules above.
 *
 * Matching is **substring**, not exact-token, for the plain-string entries
 * in `JARGON_TERMS` — deliberately, because several of those terms
 * (`owner=`, `.mjs`, `blocked_reason`) are not standalone words to begin
 * with and a word-boundary match would silently stop matching them mid-
 * identifier. It is still case-sensitive per entry (`LGTM` should not fire
 * on the ordinary word "algorithm"), which is what a case-insensitive scan
 * would get wrong — see the false-positive test in the accompanying suite.
 */
export function findJargonHits(
  field: string,
  index: number | undefined,
  text: string,
): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];
  const label = index === undefined ? field : `${field}[${index}]`;

  for (const term of JARGON_TERMS) {
    if (text.includes(term)) {
      issues.push({
        field,
        rule: "jargon",
        message: `${label} contains the denylisted term ${JSON.stringify(term)} — use plain language instead.`,
      });
    }
  }
  if (CROSS_REFERENCE.test(text)) {
    issues.push({
      field,
      rule: "jargon",
      message: `${label} contains a bare cross-reference (an issue/PR/section number) — describe the thing itself instead.`,
    });
  }
  if (ALL_CAPS_PREFIX.test(text)) {
    issues.push({
      field,
      rule: "jargon",
      message: `${label} contains an ALL-CAPS prefix (e.g. "TODO:") — write it as plain prose.`,
    });
  }
  return issues;
}

// --- Similarity check (SCHEMA.md §5, static validator 2) ---

/** Lower-cases and splits on non-word runs, dropping empties — the token set two strings are compared over. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Jaccard similarity of two strings' token sets: |intersection| / |union|,
 * in [0, 1]. Two empty strings are defined as similarity 0 (nothing to
 * compare, not "identical") so an empty summary field can never itself
 * trigger a rejection via this path — count/cap rules already refuse an
 * empty required field on their own terms.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * My design call for "similarity", stated explicitly per the task brief
 * (row #91's precedent for stating an algorithm choice in the open):
 *
 * **Algorithm: Jaccard similarity over lower-cased word-token sets.**
 * Rejected alternatives and why:
 *   - Levenshtein edit distance (the algorithm `near-duplicates.ts` uses
 *     for row #91) is a character-level metric built for short strings
 *     where a *typo* is the thing being caught (near-duplicate area ids).
 *     A summary field is a full sentence or more; edit distance over full
 *     prose is expensive (this module's own `O(m*n)` cost, repeated per
 *     candidate-field x history-row pair) and answers the wrong question —
 *     two sentences describing the same fact in different word order have a
 *     *large* edit distance despite being exactly the "log-paste" case
 *     SCHEMA.md §5 names as the thing to catch.
 *   - Token-set Jaccard treats a string as "which words appear", ignoring
 *     order and repetition — cheap to compute, and it is exactly what
 *     "boilerplate" and "log-paste" mean: the same substantive words
 *     reappearing verbatim or near-verbatim from an event's payload/body
 *     into a summary field.
 * **Threshold: >=0.85, taken directly from SCHEMA.md §5's own number**
 * ("No entry >=85% similar to any events row for this item") — not an
 * independent choice, just applied to the algorithm above.
 *
 * Compares one candidate field string against one event's comparable text
 * (see `guard.ts` for what "comparable text" means for an `events` row —
 * this function only knows about two strings).
 */
export function isTooSimilar(candidate: string, historical: string): boolean {
  return jaccardSimilarity(candidate, historical) >= SIMILARITY_REJECT_AT;
}
