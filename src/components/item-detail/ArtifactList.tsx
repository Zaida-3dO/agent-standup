// The artifacts section — MILESTONES.md #72's second piece.
//
// Hook-free and prop-driven; see `SubtaskTree.tsx`'s header.
//
// Grouped by review round rather than shown flat, because that is how a
// review history is read ("what did round 2 say"). The grouping itself is a
// pure function in `@/lib/item-detail/view` so it is testable without a
// DOM; this component only places the result.
import type { DetailArtifact } from "@/lib/item-detail/types";
import { artifactsByRound } from "@/lib/item-detail/view";
import { Markdown } from "./Markdown";
import styles from "./ItemDetail.module.css";

export interface ArtifactListProps {
  readonly artifacts: readonly DetailArtifact[];
}

/**
 * The verdicts that read as cleared. `lgtm_with_nits` and
 * `lgtm_with_followups` are on this side deliberately — both mean the work
 * is shippable, with the outstanding part tracked elsewhere (SCHEMA.md
 * §6a). Anything else, including an unrecognised future verdict, reads as
 * not-yet-cleared: the safe direction for a value this component has never
 * seen is "there may be work owed", never "this passed".
 *
 * `na` is deliberately NOT here. It means the review did not apply, which
 * is not the same claim as the work having passed one, and colouring it
 * green would let "nobody looked at this" read as "somebody approved it".
 */
const PASSING_VERDICTS: ReadonlySet<string> = new Set([
  "approved",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
]);

function verdictClass(verdict: string): string {
  return (PASSING_VERDICTS.has(verdict) ? styles.verdictPass : styles.verdictBlocked) ?? "";
}

/** A commit sha, shortened for display. Never re-derived into a link — this row has no repo URL to build one from. */
function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

export function ArtifactList({ artifacts }: ArtifactListProps) {
  const rounds = artifactsByRound(artifacts);

  return (
    <section className={styles.section} aria-label="Artifacts">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Artifacts</h2>
      </header>
      {rounds.length === 0 ? (
        <p className={styles.empty}>No artifacts yet.</p>
      ) : (
        <ul className={styles.rounds}>
          {rounds.map((round) => (
            <li key={round.round} className={styles.round} data-round={round.round}>
              <h3 className={styles.roundTitle}>Round {round.round}</h3>
              <ul className={styles.artifacts}>
                {round.artifacts.map((artifact) => (
                  <li key={artifact.id} className={styles.artifact} data-kind={artifact.kind}>
                    <div className={styles.artifactHead}>
                      <span className={styles.artifactKind}>
                        {artifact.kind.replace(/_/g, " ")}
                      </span>
                      {artifact.verdict !== null && (
                        <span
                          className={`${styles.verdict} ${verdictClass(artifact.verdict)}`}
                          data-verdict={artifact.verdict}
                        >
                          {artifact.verdict.replace(/_/g, " ")}
                        </span>
                      )}
                      {artifact.commitSha !== null && (
                        <span className={styles.sha}>{shortSha(artifact.commitSha)}</span>
                      )}
                    </div>
                    {/* A review body is markdown — headings per finding,
                        tables of severities, fenced code quoting the line
                        it is about. `compact` because it sits inside a row
                        that is already small text. */}
                    {artifact.body !== null && (
                      <Markdown source={artifact.body} density="compact" />
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
