// The Reviews tab — the material for "is this safe to merge?".
//
// ── What a review actually communicates ────────────────────────────────
//
// A review is not one claim, it is three, and a generic artifact rendering —
// a kind, a verdict string, a sha, a markdown body — carries none of them:
//
//   - **The graded findings.** `Artifact.findings` is a list of typed
//     findings with a severity each, which is the entire reason it is a list
//     rather than a paragraph. They are rendered here as structure.
//   - **The verdict TIER.** "Merge it" and "merge it, and something else
//     must still happen" are different instructions, and a verdict printed
//     as its raw identifier collapses them into one.
//   - **The follow-up item.** `lgtm_with_followups` merges immediately on
//     the strength of the deferred work being genuinely filed somewhere, so
//     a reader asked to approve needs to see whether it was. Linking it
//     makes the promise checkable rather than merely stated.
//
// ── Why rounds are the top-level grouping ──────────────────────────────
//
// A review history is read as a conversation: round 1 asked for changes,
// round 2 cleared it. Ordering by anything else — severity across rounds,
// say — would put a round-1 finding that has since been fixed next to a
// live round-3 one with nothing distinguishing them, which is the opposite
// of what a merge decision needs. Severity grouping happens INSIDE a review,
// where every finding shares a round and is comparable.
//
// **The latest round is marked.** A stale approval and a current one are
// otherwise identical rows, and the whole tip-currency rule turns on which
// is which.
//
// Hook-free and prop-driven — see `tests/helpers/react-element.ts`.
import type { DetailArtifact } from "@/lib/item-detail/types";
import { artifactsByRound } from "@/lib/item-detail/view";
import { verdictDisplay } from "@/lib/item-detail/verdicts-display";
import { FindingsList } from "./FindingsList";
import { VerdictBadge } from "./VerdictBadge";
import { Markdown } from "./Markdown";
import styles from "./ItemDetail.module.css";

export interface ReviewsPanelProps {
  readonly artifacts: readonly DetailArtifact[];
}

/**
 * A commit sha, shortened for display — ten characters, which is
 * unambiguous in any repository this will see and short enough to sit in a
 * metadata row.
 *
 * Never turned into a link: an artifact row carries no repository URL, so a
 * link would have to be assembled from a host this code does not know, and a
 * link to the wrong repository is worse than no link.
 */
function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

/** An artifact kind as it reads on screen — `code_review` as "code review". */
function humanKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

export function ReviewsPanel({ artifacts }: ReviewsPanelProps) {
  const rounds = artifactsByRound(artifacts);

  if (rounds.length === 0) {
    return (
      <section className={styles.section} aria-label="Reviews">
        <p className={styles.empty}>
          No reviews yet — nothing has assessed this work, which is not the same as it having
          passed.
        </p>
      </section>
    );
  }

  const latestRound = rounds[rounds.length - 1]?.round;

  return (
    <section className={styles.section} aria-label="Reviews">
      <ul className={styles.rounds}>
        {/* Rounds descend: the current round is the one a merge decision
            turns on, so it is at the top rather than at the bottom of a
            history the reader has to scroll past to reach it. */}
        {[...rounds].reverse().map((round) => {
          const isLatest = round.round === latestRound;
          return (
            <li
              key={round.round}
              className={styles.round}
              data-round={round.round}
              data-latest-round={isLatest || undefined}
            >
              <h3 className={styles.roundTitle}>
                Round {round.round}
                {isLatest && <span className={styles.roundCurrent}>current</span>}
              </h3>
              <ul className={styles.artifacts}>
                {round.artifacts.map((artifact) => (
                  <li key={artifact.id} className={styles.review} data-kind={artifact.kind}>
                    <div className={styles.reviewHead}>
                      <span className={styles.artifactKind}>{humanKind(artifact.kind)}</span>
                      {artifact.verdict !== null && <VerdictBadge verdict={artifact.verdict} />}
                      {artifact.commitSha !== null && (
                        <span className={styles.sha} title={artifact.commitSha}>
                          {shortSha(artifact.commitSha)}
                        </span>
                      )}
                    </div>

                    {/* The tier's obligation, on its own line under the
                        header. Not a tooltip — see `VerdictBadge`. */}
                    {artifact.verdict !== null && (
                      <p className={styles.verdictMeaning}>
                        {verdictDisplay(artifact.verdict).meaning}
                      </p>
                    )}

                    {/* The follow-up a `lgtm_with_followups` merge is
                        conditional on. Shown whenever one is linked rather
                        than only for that verdict: a review that filed
                        follow-up work has done something worth seeing
                        whatever tier it landed on. */}
                    {artifact.followUpItemId !== null && (
                      <p className={styles.followUp}>
                        Follow-up filed as{" "}
                        <a
                          className={styles.followUpLink}
                          href={`/items/${encodeURIComponent(artifact.followUpItemId)}`}
                        >
                          {artifact.followUpItemId}
                        </a>
                      </p>
                    )}

                    <FindingsList findings={artifact.findings} />

                    {/* The prose the reviewer wrote, after the structured
                        findings rather than before them. The findings are
                        the graded, comparable part; the body is the
                        narrative around them, and a reader scanning for
                        severity should not have to pass a page of prose to
                        reach it. */}
                    {artifact.body !== null && artifact.body.trim() !== "" && (
                      <details className={styles.reviewNotes}>
                        <summary className={styles.disclosureSummary}>
                          Reviewer&rsquo;s notes
                        </summary>
                        <Markdown source={artifact.body} density="compact" />
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
