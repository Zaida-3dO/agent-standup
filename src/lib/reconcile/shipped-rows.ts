// Finds non-terminal board rows whose work has already shipped, so a crew
// is not dispatched to rebuild something a merged pull request already
// delivered. Row `17e83ab8-4d4f-4d2b-a00d-92651228112b`.
//
// ── What this deliberately is NOT ───────────────────────────────────────
//
// Not an automation that closes anything. The row that commissioned this
// names three ways a confident closer would be wrong: a shipped row is not
// always a pull request with a matching title or branch (two of the four
// examples shipped inside a PR named for other work entirely); a row can be
// PARTIALLY shipped, where "some of it landed" is a live possibility a
// filename search cannot rule out; and a deliverable existing on `main` is
// not the same fact as the row's acceptance criteria being met. Reconciling
// that last one needs a human or an agent reading the row's prose against
// the merged source — this module does not attempt it, and says so in its
// output rather than guessing.
//
// ── The one signal this module trusts ───────────────────────────────────
//
// A merged pull request whose title or body contains the row's own id,
// verbatim, as a UUID. That is deliberately narrower than matching on
// branch name or PR title against the row's title — both of those were
// tried informally against the four rows that motivated this and both
// missed real matches (see the row body: "matching by branch name or title
// would have missed both"). An id is unambiguous where a title is not: two
// unrelated rows can share words, but only one row has this UUID.
//
// The cost of that narrowness is honest under-reporting, not
// over-reporting, which is the safe direction for a report nothing acts on
// automatically. A PR that shipped a row's work without naming its id is
// invisible to this module — that gap is named explicitly in the report
// rather than papered over with a weaker, guessier signal.
import type { MergedPullRequest, ReconciliationCandidate, ReconciliationInput } from "./types";

/** Matches a standard UUID (v1–v5, case-insensitive), not anchored — ids appear inline in prose. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** All UUIDs mentioned in a piece of text, lower-cased, de-duplicated. */
export function uuidsMentionedIn(text: string | null | undefined): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  for (const match of text.matchAll(UUID_RE)) {
    found.add(match[0].toLowerCase());
  }
  return found;
}

/**
 * The merged PRs that mention a given row id in their title or body.
 *
 * Title is checked too, not just body: a PR that named the row id in its
 * title as well as its body is not a different case, but a PR whose ONLY
 * mention is in the title (short, terse PRs) would be missed if body were
 * the only field read.
 */
export function pullRequestsReferencing(
  itemId: string,
  pulls: readonly MergedPullRequest[],
): MergedPullRequest[] {
  const needle = itemId.toLowerCase();
  return pulls.filter((pr) => {
    return uuidsMentionedIn(pr.title).has(needle) || uuidsMentionedIn(pr.body).has(needle);
  });
}

/**
 * Builds the candidate list: one entry per non-terminal row that at least
 * one merged pull request references by id.
 *
 * A row with no referencing PR produces no candidate at all — this function
 * only ever reports evidence *for* a row being shipped, never a verdict
 * that it is not. Absence of evidence here is not evidence of absence; see
 * the module header for why deliverable-existence is not attempted.
 *
 * Deterministic order: rows appear in the order they were given, and each
 * row's PRs are sorted newest-merged-first so the most likely candidate
 * (the most recent reference) reads first.
 */
export function findShippedCandidates(input: ReconciliationInput): ReconciliationCandidate[] {
  const candidates: ReconciliationCandidate[] = [];
  for (const item of input.items) {
    const referencing = pullRequestsReferencing(item.id, input.mergedPullRequests).sort((a, b) => {
      const aTime = a.mergedAt ? Date.parse(a.mergedAt) : 0;
      const bTime = b.mergedAt ? Date.parse(b.mergedAt) : 0;
      return bTime - aTime;
    });
    if (referencing.length === 0) continue;
    candidates.push({
      item,
      confidence: "high",
      reason: "id-in-merged-pr",
      evidence: referencing,
    });
  }
  return candidates;
}
