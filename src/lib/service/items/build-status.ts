// "Is this item's pull request passing?" — folded from the `check_run`
// artifacts the item already holds, and reported with the two facts that say
// how much the answer is worth.
//
// See `src/lib/check-runs.ts` for why the status is reported in rather than
// fetched out, and why staleness is two orthogonal facts rather than one
// boolean. This module is the read that puts them together.
//
// ── Why this is a fold and not a stored column ──────────────────────────
//
// `artifacts` is append-only. A build that goes from pending to passing is a
// **new** `check_run` row, exactly as a PR that closes is a new
// `pull_request` row — nothing in this product updates an artifact after it
// is written, and the merge gate's whole "at tip" reasoning depends on that
// staying true. So "what is the build status now" is the newest row, and the
// history of every build this item ever reported survives underneath it.
//
// ── Why it never blocks ─────────────────────────────────────────────────
//
// Every failure mode here is a value, not a throw. No `check_run` row, a row
// whose status is unreadable, a row with no commit, an item with no tip to
// compare against: each produces a payload that says what is not known. The
// read that carries this is `get_item_detail`, and an item's detail must come
// back whether or not its build status is knowable — a read that fails
// because a subordinate fact is missing is worse than one that says it does
// not know, and this fact is missing on the majority of items in any store.
import { checkRunAgeSeconds, checkRunStatusOf, type CheckRunStatus } from "@/lib/check-runs";
import { isLinkableUrl } from "@/lib/pull-requests";
import { shaMatchesTipOrLineage } from "../guards/artifact-tip";

/**
 * The build status an item is reporting, as a reader sees it.
 *
 * Every field that could be unknown is nullable and is `null` when unknown —
 * never defaulted to a plausible value. This is a payload whose entire
 * purpose is to let a caller decide how much to trust it, and a guess dressed
 * as a fact defeats that completely.
 */
export interface BuildStatusView {
  /**
   * The reported state, or `null` when the newest `check_run` row carries a
   * body this vocabulary does not recognise.
   *
   * `null` rather than a default: unlike a PR's open/closed, there is no
   * safe direction to guess a build in. See `checkRunStatusOf`.
   */
  readonly status: CheckRunStatus | null;
  /**
   * When the status was recorded, ISO-8601. Always present — a fold that
   * produced a status necessarily read a row, and every row has a timestamp.
   */
  readonly recordedAt: string;
  /**
   * How many whole seconds ago it was recorded.
   *
   * The headline staleness fact, and the one that always applies. A caller
   * with no other information can still judge that a status learned four
   * seconds ago and one learned yesterday are not the same evidence.
   */
  readonly ageSeconds: number;
  /**
   * The commit the build ran against, where the reporter recorded one.
   */
  readonly commitSha: string | null;
  /**
   * Whether that commit is still the item's tip — or `null` when the
   * question does not apply.
   *
   * The second staleness fact, orthogonal to age. `true` means the build
   * describes the code at the item's tip. `false` means it describes code
   * the tip has moved past, however recently the status was recorded —
   * this is the one that catches a green build a caller would otherwise read
   * as permission to merge work the build never saw.
   *
   * `null`, not `false`, when it is unanswerable: the status recorded no
   * commit, or the item has no `commit` artifact to be a tip. Reporting an
   * unanswerable question as `false` would read as "this build is stale"
   * about one that may be perfectly current, which is a false alarm on the
   * majority of items — and a staleness signal that cries wolf is one
   * readers learn to skip.
   *
   * Abbreviation-tolerant and supersession-aware, via the same
   * `shaMatchesTipOrLineage` the merge gate uses: a build reported against a
   * 7-character sha from `git log --oneline` is at the tip of a 40-character
   * commit artifact for the same commit, and a build against a commit that a
   * squash rewrote is still at the tip it was squashed into.
   */
  readonly atTip: boolean | null;
  /**
   * A link to the build, where the reporter recorded one and it is a plain
   * http(s) address.
   *
   * Filtered through the same `isLinkableUrl` a PR URL passes, and for the
   * same reason: this value is rendered as a link by whatever displays it,
   * and a `javascript:` or `data:` target — or one carrying a `)` that ends
   * a markdown link early — is an injection from a string that arrived over
   * the API. A ref that does not pass is reported as `null`, so a caller
   * never receives something it would render into a link to nothing.
   */
  readonly url: string | null;
  /** Which review round the status was reported at. */
  readonly reviewRound: number;
}

/** The columns this fold reads off a `check_run` artifact row. */
export interface CheckRunArtifactRow {
  readonly kind: string;
  readonly body: string | null;
  readonly ref: string | null;
  readonly commitSha: string | null;
  readonly reviewRound: number;
  readonly createdAt: Date;
}

/**
 * Folds an item's artifacts into its current build status, or `null` when it
 * has reported none.
 *
 * `artifacts` is expected in the order `get_item_detail` already reads them —
 * ascending by round, then `createdAt`, then `seq` — and the **last**
 * matching row wins. Taking the last of an ascending list rather than sorting
 * a copy here is the same walk the client-side mirrors in `item-detail/view.ts`
 * perform over the same array, so the server and the client cannot disagree
 * about which row is newest.
 *
 * `null` for "no build reported" rather than a view with every field empty:
 * an item with no `check_run` row has not reported a build, which is a
 * different statement from having reported one nobody can read, and a caller
 * must be able to tell those apart. The second is a `BuildStatusView` with a
 * `null` status.
 */
export function foldBuildStatus(
  artifacts: readonly CheckRunArtifactRow[],
  tipCommitSha: string | null,
  tipLineage: ReadonlySet<string>,
  now: Date,
): BuildStatusView | null {
  let newest: CheckRunArtifactRow | null = null;
  for (const artifact of artifacts) {
    if (artifact.kind === "check_run") {
      newest = artifact;
    }
  }
  if (newest === null) {
    return null;
  }

  const commitSha = newest.commitSha;
  // Three ways this question has no answer, all reported the same way. Two
  // of them are the ordinary case on a healthy item — a build reported
  // without a commit, or an item that has not recorded a commit artifact —
  // so `null` here is not an error path.
  const atTip: boolean | null =
    commitSha === null || tipCommitSha === null
      ? null
      : shaMatchesTipOrLineage(commitSha, tipCommitSha, tipLineage);

  return {
    status: checkRunStatusOf(newest.body),
    recordedAt: newest.createdAt.toISOString(),
    ageSeconds: checkRunAgeSeconds(newest.createdAt, now),
    commitSha,
    atTip,
    // Trimmed on the way out for the same reason the PR read trims: the
    // stored value may carry whitespace a caller did not intend to be part
    // of the URL, and `isLinkableUrl` judges the trimmed form.
    url: isLinkableUrl(newest.ref) ? newest.ref!.trim() : null,
    reviewRound: Number(newest.reviewRound),
  };
}
