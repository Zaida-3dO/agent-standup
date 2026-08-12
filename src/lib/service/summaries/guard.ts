// The summaries guard — wires `validate.ts` into the state-machine guard
// framework row #15 built. SCHEMA.md §16: "any completed state | A valid
// summaries row." See MILESTONES.md #21.
//
// This module owns *validating a candidate summary against everything
// SCHEMA.md §5 states as a static rule* (shape, caps, reject-don't-truncate,
// similarity, jargon) at the point an item tries to enter a completed state.
// It does not own writing the `summaries` row — that is row #27's
// transition-and-complete operation, which will supply `fields.summary` on
// the transition request and can reuse `validateSummaryCandidate` directly
// (exported below) without going through the guard registry at all, exactly
// as `blocked`'s guard (row #16) reads `fields.blocked_reason`.
import { GuardRejectedError } from "../errors";
import {
  guardRegistry,
  guardOk,
  guardRejected,
  type Guard,
  type GuardInput,
} from "../state-machine";
import {
  isTooSimilar,
  validateSummaryShape,
  type NotDoneEntry,
  type SummaryCandidate,
  type SummaryValidationIssue,
  type WhatToTestEntry,
} from "./validate";

/** The four completed states (SCHEMA.md §1.1's "Completed" column). Matches `transition.ts`'s own set. */
const COMPLETED_STATES = new Set(["merged", "research_done", "wont_do", "cancelled"]);

export const SUMMARY_REQUIRED_GUARD_ID = "summaries.required_and_valid";

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
 * candidate against every prior `events` row for `itemId`. Exported so the
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
 * The registered guard: entering any completed state requires a valid
 * `summaries` candidate in `fields.summary` — shape, caps, jargon and
 * similarity, all in one evaluation, so a caller sees every problem in one
 * rejection round rather than fixing them one at a time across retries.
 *
 * Fetches this item's own `events` rows inside `input.db` — the same
 * transaction handle every other guard runs in (`guard.ts`'s own doc: "a
 * guard gets what it needs to decide"), so this reuses the one transaction
 * rather than opening a second connection.
 */
export const summaryRequiredGuard: Guard = {
  id: SUMMARY_REQUIRED_GUARD_ID,
  description: "Entering a completed state requires a valid summaries row (SCHEMA.md §5).",
  appliesTo: (_from, to) => COMPLETED_STATES.has(to),
  async check(input: GuardInput) {
    const candidate = readCandidate(input.fields);
    if (!candidate) {
      return guardRejected(
        "A summary is required to complete this item — supply shipped, not_done, user_facing and the branch it forces.",
        { fields: ["summary"] },
      );
    }

    const shapeIssues = validateSummaryShape(candidate);

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

/** Installs the guard into the shared registry. Call once at process start (see `../index.ts`). */
export function registerSummaryGuard(registry = guardRegistry): void {
  if (!registry.has(SUMMARY_REQUIRED_GUARD_ID)) {
    registry.register(summaryRequiredGuard);
  }
}

// Re-exported so a future row (#22, #27) that needs to validate a summary
// candidate directly — not through a transition — has one entry point, not
// two competing ones.
export { validateSummaryShape, type SummaryCandidate, type SummaryValidationIssue };
export type { GuardRejectedError };
