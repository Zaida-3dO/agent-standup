// The review-verdict vocabulary and what each tier MEANS — SCHEMA.md §6a.
//
// One module, because "which verdicts approve" is asked in three different
// places (the merge gate's code-review clause, its visual-review clause, and
// its authorisation clause) and each of them used to ask it by writing the
// literal `'approved'` into its own SQL string. A literal in three query
// bodies is three chances to add a fourth verdict and update two of them.
//
// Nothing here touches the database. It is a closed vocabulary and three
// predicates over it, so it is testable without one — which matters, because
// these predicates decide whether a merge is allowed.

/** Every label `Artifact.verdict` can hold. Mirrors `Verdict` in schema.prisma exactly. */
export const VERDICTS = [
  "approved",
  "changes_required",
  "na",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * The verdicts that count as an approval — the set every "is there an
 * approving artifact" question ranges over.
 *
 * All three `lgtm` tiers approve. That is what tiering is FOR: a review that
 * found cosmetic nits, or findings worth doing later, has still said the
 * change is sound. What separates them is not whether they approve but what
 * else has to be true before the merge lands:
 *
 *   - `lgtm` merges on its own.
 *   - `lgtm_with_nits` merges once the nits are addressed. No new gate
 *     enforces that, and none is needed: addressing a nit produces a commit,
 *     a commit moves the item's tip, and the existing tip-currency check
 *     (guards/artifact-tip.ts) then refuses the stale approval until the
 *     light re-review lands at the new tip. A verdict that genuinely needed
 *     no code change is already at tip and merges — correctly.
 *   - `lgtm_with_followups` merges immediately, and is the only tier with an
 *     extra requirement of its own: `requiresLinkedFollowUp` below.
 *
 * `approved` is in the set because it predates the tiering and cannot be
 * removed from the enum (schema.prisma's own note on `Verdict`). Keeping it
 * is what makes the tiering additive rather than a semantic change: every
 * row and every gate decision that existed before this vocabulary landed
 * decides identically after it.
 *
 * `na` is NOT an approval. It means "this artifact kind has no verdict to
 * give" — a `commit` or a `test_run` — and reading it as a pass would let an
 * item merge on the strength of an artifact that never reviewed anything.
 */
export const APPROVING_VERDICTS: readonly Verdict[] = [
  "approved",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
];

const APPROVING = new Set<string>(APPROVING_VERDICTS);

/** Whether `verdict` (a raw column value, possibly null or unrecognised) approves. */
export function isApprovingVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && APPROVING.has(verdict);
}

/** Whether `verdict` is one of the labels the column can hold at all. */
export function isVerdict(verdict: string | null | undefined): verdict is Verdict {
  return verdict != null && (VERDICTS as readonly string[]).includes(verdict);
}

/**
 * Whether merging on the strength of `verdict` additionally requires a
 * linked follow-up item.
 *
 * True for `lgtm_with_followups` and nothing else. The verdict's whole
 * purpose is to stop a non-blocking finding from costing a full extra review
 * round — the change merges as it stands and the finding is done separately.
 * That bargain only holds if the "separately" part is real. Left to whoever
 * remembers, this becomes the verdict everyone reaches for to skip a round,
 * and the follow-ups quietly never happen; the finding was recorded, nobody
 * was ever going to read it again, and the review round it saved was paid
 * for with work that evaporated.
 *
 * So the requirement is enforced at the gate the verdict buys — the merge —
 * rather than at the moment the verdict is written. Writing the verdict is a
 * reviewer stating an opinion and should not be blocked; spending it is the
 * irreversible step, and that is where the follow-up has to exist.
 */
export function requiresLinkedFollowUp(verdict: string | null | undefined): boolean {
  return verdict === "lgtm_with_followups";
}
