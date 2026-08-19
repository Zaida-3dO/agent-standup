// Guard — summaries: entering any completed state requires a valid
// `summaries` row. See docs/plans/MILESTONES.md #21, SCHEMA.md §16 ("any
// completed state | A valid summaries row"), §5, §5a.
//
// Lives here — `src/lib/service/guards/`, alongside `hierarchy.ts` (#19) —
// rather than self-registering from `../summaries/`, so it is covered by
// `tests/guards-registration.test.ts`'s canonicalisation sweep the same way
// every other hand-written guard is: that test reads every guard `id`
// declared under this directory straight from source and asserts
// `guards/index.ts`'s `ALL_GUARDS` lists it, which only works for a guard
// that actually lives here. `../summaries/validate.ts` still owns the pure
// shape/caps/similarity/jargon logic — reused by row #27's future
// transition-and-complete operation directly, without going through the
// guard registry at all, exactly as this file reuses it here.
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";
import {
  COMPLETED_STATES as COMPLETED_STATE_LIST,
  isNonDeliveryState,
  isTooSimilar,
  validateSummaryShape,
  type NotDoneEntry,
  type SummaryCandidate,
  type SummaryValidationIssue,
  type WhatToTestEntry,
} from "../summaries/validate";

/**
 * The four completed states (SCHEMA.md §1.1's "Completed" column). Matches
 * `transition.ts`'s own set.
 *
 * Built from `summaries/validate.ts`'s own partition of those four into the
 * delivery and non-delivery halves, rather than written out again here. The
 * two lists have to stay in agreement — this guard decides *whether* a
 * summary is required and the validator decides *which fields* it needs, so
 * a state present in one and missing from the other would be a state whose
 * summary is either unvalidated or unreachable. Deriving the set makes that
 * disagreement unrepresentable instead of merely unlikely.
 */
const COMPLETED_STATES = new Set<string>(COMPLETED_STATE_LIST);

/**
 * Reads `fields.summary` off a `GuardInput` as a `SummaryCandidate`, or
 * returns `undefined` if it is missing or not even shaped like an object —
 * the guard turns `undefined` into its own "summary is required" rejection
 * rather than this function guessing at partial input.
 */
function readCandidate(fields: Readonly<Record<string, unknown>>): SummaryCandidate | undefined {
  const raw = fields.summary;
  if (raw === null || raw === undefined || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    shipped: Array.isArray(r.shipped) ? (r.shipped as string[]) : [],
    not_done: Array.isArray(r.not_done) ? (r.not_done as NotDoneEntry[]) : [],
    user_facing: r.user_facing === true,
    what_to_test: Array.isArray(r.what_to_test)
      ? (r.what_to_test as WhatToTestEntry[])
      : r.what_to_test === null
        ? null
        : undefined,
    how_verified:
      typeof r.how_verified === "string"
        ? r.how_verified
        : r.how_verified === null
          ? null
          : undefined,
    watch_for: Array.isArray(r.watch_for) ? (r.watch_for as string[]) : [],
    decision: typeof r.decision === "string" ? r.decision : r.decision === null ? null : undefined,
  };
}

/**
 * The comparable text for one prior `events` row — what a candidate summary
 * field is checked for similarity against. `payload` is JSON (arbitrary
 * shape per event `type`, SCHEMA.md §3 "Payload shapes") and `body` is a
 * free-text column used by some event types (e.g. `note`) — concatenating
 * both is the honest "everything this row said in prose" for the
 * log-paste case the check exists to catch, without this guard having to
 * know every payload shape by `type`.
 */
function eventComparableText(row: { body: string | null; payload: unknown }): string {
  const payloadText =
    row.payload === null || row.payload === undefined ? "" : JSON.stringify(row.payload);
  return [row.body ?? "", payloadText].join(" ");
}

/**
 * Every string field a candidate summary carries, paired with a label for
 * the rejection message — what the similarity check sweeps per history row.
 * `not_done[].text` and `what_to_test[].text` are included: a pasted log
 * line dropped into a follow-up note or a test step is exactly as much
 * boilerplate as one dropped into `shipped`.
 */
function candidateTextFields(candidate: SummaryCandidate): { field: string; text: string }[] {
  const fields: { field: string; text: string }[] = [];
  candidate.shipped.forEach((text, i) => fields.push({ field: `shipped[${i}]`, text }));
  candidate.not_done.forEach((entry, i) =>
    fields.push({ field: `not_done[${i}].text`, text: entry.text }),
  );
  (candidate.what_to_test ?? []).forEach((step, i) =>
    fields.push({ field: `what_to_test[${i}].text`, text: step.text }),
  );
  if (candidate.how_verified) fields.push({ field: "how_verified", text: candidate.how_verified });
  candidate.watch_for.forEach((text, i) => fields.push({ field: `watch_for[${i}]`, text }));
  return fields;
}

/**
 * Runs the similarity check (SCHEMA.md §5, static validator 2) for one
 * candidate against every prior `events` row for `itemId`. Exported so this
 * guard and a direct unit test can both drive it against a hand-built row
 * list without a database.
 */
export function findSimilarityIssues(
  candidate: SummaryCandidate,
  historyRows: readonly { body: string | null; payload: unknown }[],
): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];
  const histories = historyRows.map(eventComparableText).filter((t) => t.trim().length > 0);
  for (const { field, text } of candidateTextFields(candidate)) {
    if (text.trim().length === 0) continue;
    for (const historical of histories) {
      if (isTooSimilar(text, historical)) {
        issues.push({
          field,
          rule: "similarity",
          message: `${field} is too similar to an existing event on this item — write it in your own words instead of pasting the log.`,
        });
        break; // one hit is enough to reject this field; no need to keep comparing
      }
    }
  }
  return issues;
}

/**
 * Registered as `summaries.required_and_valid`. Entering any completed
 * state requires a valid `summaries` candidate in `fields.summary` — shape,
 * caps, jargon and similarity, all in one evaluation, so a caller sees
 * every problem in one rejection round rather than fixing them one at a
 * time across retries.
 *
 * Fetches this item's own `events` rows inside `input.db` — the same
 * transaction handle every other guard runs in (`guard.ts`'s own doc: "a
 * guard gets what it needs to decide"), so this reuses the one transaction
 * rather than opening a second connection.
 */
export const summaryRequiredGuard: Guard = {
  // A literal string on this line, not a constant reference — the
  // registration test in this repo's guards suite finds every guard by
  // pattern-matching this directory's source text for a quoted id field,
  // the same way `hierarchy.ts` declares its own id as a literal. A
  // constant reference here would be invisible to that scan and silently
  // under-count this guard. `SUMMARY_REQUIRED_GUARD_ID` below is derived
  // *from* this literal instead, so there is exactly one place the real
  // string is written.
  id: "summaries.required_and_valid",
  description: "Entering a completed state requires a valid summaries row (SCHEMA.md §5).",
  appliesTo: (_from, to) => COMPLETED_STATES.has(to),
  async check(input: GuardInput) {
    const candidate = readCandidate(input.fields);
    if (!candidate) {
      // The message spells the conditional out — which field `user_facing`
      // selects, in both directions — rather than referring to it as a
      // branch.
      //
      // That is a deliberate avoidance, not verbosity. The word "branch"
      // cannot be used neutrally in this particular refusal: `branch` is a
      // real column on the very item being completed, and a summary is
      // written at precisely the moment a caller is thinking about the git
      // branch it is merging. A refusal mentioning "the branch" is therefore
      // read as asking for that column by callers who are not being careless
      // — the ambiguity is genuinely in the sentence — and it sends them to
      // supply the wrong field, costing the round trip a good refusal
      // exists to save. Naming `what_to_test` and `how_verified` outright
      // is longer and has exactly one reading.
      // Worded for the state actually being entered. A caller closing a
      // duplicate as `wont_do` who is told to "supply shipped" has been
      // told to claim a delivery that did not happen — the exact confusion
      // the delivery/non-delivery split exists to remove, and it would be
      // reintroduced here if this one sentence stayed generic.
      return guardRejected(
        isNonDeliveryState(input.to)
          ? `A summary is required to complete this item — closing as ${input.to} needs a ` +
              "decision saying why the work is not being done, plus not_done and user_facing, " +
              "and what user_facing then requires: what_to_test when it is true, how_verified " +
              "when it is false. shipped is not required and must be empty."
          : "A summary is required to complete this item — supply shipped, not_done and " +
              "user_facing, plus what user_facing then requires: what_to_test when it is true, " +
              "how_verified when it is false.",
        { fields: ["summary"] },
      );
    }

    const shapeIssues = validateSummaryShape(candidate, input.to);

    const historyRows = await input.db.$queryRawUnsafe<{ body: string | null; payload: unknown }[]>(
      `SELECT "body", "payload" FROM "Event" WHERE "itemId" = $1`,
      input.item.id,
    );
    const similarityIssues = findSimilarityIssues(candidate, historyRows);

    const issues = [...shapeIssues, ...similarityIssues];
    if (issues.length === 0) return guardOk;

    return guardRejected(issues.map((i) => i.message).join(" "), {
      fields: [...new Set(issues.map((i) => i.field))],
      details: { issues },
    });
  },
};

/** `summaryRequiredGuard.id`, named for callers that want the id without importing the guard object. */
export const SUMMARY_REQUIRED_GUARD_ID = summaryRequiredGuard.id;
