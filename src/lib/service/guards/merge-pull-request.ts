// Whether the item's pull request has actually merged — the evidence
// `merge_authority = pr` requires. SCHEMA.md §16's "plus an auth check per
// `merge_authority`".
//
// ── Why this value exists ───────────────────────────────────────────────
//
// The other three authorities answer "who decides": nobody, a person, or the
// agent at the gate. The rule crews actually run is not a decider at all —
// *this item may merge only when its PR has merged* — and it is objective
// and externally checkable rather than a judgement. With no value for it,
// that rule was expressed as `pre_approved` plus enforcement outside the
// product, which the board cannot see and which is advisory by construction.
//
// **It is stricter than `pre_approved`, not a softening.** `pre_approved`
// returns ok immediately, having checked nothing; this has a fact to verify
// and refuses until it holds.
//
// ── Why it reads only the NEWEST row ────────────────────────────────────
//
// `pull_request` artifacts are append-only and a status change is recorded
// as a new row superseding the old (`@/lib/pull-requests`), so an item's PR
// history is a sequence: opened, perhaps closed, perhaps re-opened, perhaps
// merged. Only the last row describes the PR *now*.
//
// Reading "is there ANY row saying merged" would be the obvious alternative
// and is wrong in the direction that matters: an item whose first PR merged
// and whose follow-up PR was then closed unmerged would pass on the strength
// of the older row, which is precisely the abandoned-work case this clause
// exists to catch. A merge is not a fact that, once true, stays true of
// whatever the item does next.
//
// ── Why it does not scope to the tip commit ─────────────────────────────
//
// Every other merge-time check pins its evidence to a commit, because a
// review or an approval is a statement about a particular state of the code
// and stops applying when the code moves. This clause deliberately does not,
// and the asymmetry is intentional.
//
// A `pull_request` artifact records a PR, not a commit — the URL is the fact
// being stored, and `commitSha` is typically unset on these rows because the
// PR outlives every individual commit on its branch. More importantly, a
// merged PR is a statement about the branch *as merged*: whatever the forge
// squashed or rebased is what landed, and asking whether that sha matches
// the item's tip re-asks a question the forge has already answered with more
// information than this service has. Pinning to a tip here would make the
// clause unsatisfiable in the ordinary squash-merge workflow — the exact
// failure mode that had to be fixed for the review clauses — while adding no
// safety, because the PR being merged is itself the evidence that the work
// landed.
//
// What this clause does NOT do is stand in for a review. It reads nothing
// about quality and grants nothing: `merge.requires_approving_code_review`
// and `merge.requires_visual_review` are separate clauses that never consult
// `mergeAuthority`, and an item on `pr` still has to satisfy both. This
// answers only "has the work actually landed on the forge".
import type { TransactionHandle } from "../context";
import { pullRequestStatusOf, type PullRequestStatus } from "@/lib/pull-requests";

/** The artifact kind recording a pull request. */
export const PULL_REQUEST_KIND = "pull_request";

interface PullRequestRow {
  id: string;
  body: string | null;
  ref: string | null;
}

/** What the newest recorded pull request says, as the guard needs it. */
export interface PullRequestMergeResult {
  /** True only when a `pull_request` row exists and the newest one reports `merged`. */
  readonly satisfied: boolean;
  /**
   * The status the newest row reports, or `undefined` when the item has no
   * `pull_request` artifact at all.
   *
   * The two are distinguished because they need different things said. "No
   * PR recorded" is usually a bookkeeping gap — the PR exists on the forge
   * and nobody wrote it down — and the remedy is to record it. "The newest
   * PR says open" means the work genuinely has not landed yet, and the
   * remedy is to merge it. A caller told the wrong one goes and does the
   * wrong thing.
   */
  readonly status?: PullRequestStatus;
  /** The newest row's URL, when it has one, so a refusal can point at the PR. */
  readonly ref?: string;
}

/**
 * Whether the item's newest `pull_request` artifact reports that it merged.
 *
 * Ordered `createdAt DESC, seq DESC` — the same total ordering
 * `progress_report` uses to pick the row describing a PR now. `seq` rather
 * than `id` because `Artifact.id` is a random uuid and carries no insertion
 * order, so two rows written in the same transaction (or the same clock
 * tick) would otherwise have no deterministic winner. Here that tiebreak is
 * load-bearing rather than cosmetic: a merge gate that could pick either of
 * two rows would pass or refuse depending on uuid ordering.
 *
 * The status is read through `pullRequestStatusOf` rather than compared to
 * the literal `'merged'` in SQL, so rows written before the status
 * vocabulary existed are read the same lenient way every other reader reads
 * them. That leniency only ever *narrows* toward a real status — an
 * unrecognised body still falls through to `open` — so a row nobody
 * validated cannot promote itself to a merge this clause would accept.
 */
export async function pullRequestHasMerged(
  db: TransactionHandle,
  itemId: string,
): Promise<PullRequestMergeResult> {
  const rows = await db.$queryRawUnsafe<PullRequestRow[]>(
    `SELECT "id", "body", "ref"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
      ORDER BY "createdAt" DESC, "seq" DESC
      LIMIT 1`,
    itemId,
    PULL_REQUEST_KIND,
  );
  const newest = rows[0];
  if (!newest) return { satisfied: false };

  const status = pullRequestStatusOf(newest.body);
  return {
    satisfied: status === "merged",
    status,
    ...(newest.ref ? { ref: newest.ref } : {}),
  };
}
