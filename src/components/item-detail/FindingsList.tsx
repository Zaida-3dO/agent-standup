// A review's findings, grouped by severity — the stored structured JSON,
// rendered as structure.
//
// `Artifact.findings` holds a list of typed findings, each with its own
// severity, and a severity per finding is the entire reason the column is a
// list rather than a paragraph. Nothing read it back: a reviewer graded five
// findings and a reader saw whatever prose happened to be in `body` beside
// them. This renders the graded list itself, most severe group first, so the
// question a reader actually arrives with — "is there anything serious in
// here" — is answered by the shape of the section rather than by reading it.
//
// The grouping and the ordering are pure functions in
// `@/lib/item-detail/findings-view`, so they are tested without a DOM; this
// component places the result and does no deriving of its own.
//
// Hook-free and prop-driven — see `tests/helpers/react-element.ts`.
import {
  displayFindings,
  groupFindingsBySeverity,
  highestSeverity,
  severityLabel,
} from "@/lib/item-detail/findings-view";
import { Markdown } from "./Markdown";
import styles from "./ItemDetail.module.css";

export interface FindingsListProps {
  /** The stored `findings` value, untrusted and of unknown shape. */
  readonly findings: unknown;
}

export function FindingsList({ findings }: FindingsListProps) {
  const parsed = displayFindings(findings);

  // Nothing recorded is a fact worth stating, not a section to omit. A
  // review with no structured findings and a review whose findings failed to
  // render look identical if both show nothing at all, and the first is
  // common while the second is a bug — so the common one says so out loud.
  if (parsed.length === 0) {
    return (
      <p className={styles.empty} data-findings="none">
        No structured findings recorded on this review.
      </p>
    );
  }

  const groups = groupFindingsBySeverity(parsed);
  const worst = highestSeverity(parsed);

  return (
    <section className={styles.findings} aria-label="Findings" data-findings-count={parsed.length}>
      <p className={styles.findingsLead}>
        {parsed.length} {parsed.length === 1 ? "finding" : "findings"}
        {worst !== null && (
          <>
            {" · most severe: "}
            <span className={styles.findingSeverity} data-severity={worst}>
              {severityLabel(worst)}
            </span>
          </>
        )}
      </p>
      {groups.map((group) => (
        <div
          key={group.severity ?? "ungraded"}
          className={styles.findingGroup}
          data-severity={group.severity ?? "ungraded"}
        >
          <h4 className={styles.findingGroupTitle}>
            {/* The severity is named as well as coloured. A group whose only
                marker is a hue disappears for a reader who cannot separate
                the reds from the oranges, and severity is the one thing on
                this page a merge decision turns on. */}
            <span className={styles.findingSeverity} data-severity={group.severity ?? "ungraded"}>
              {severityLabel(group.severity)}
            </span>
            <span className={styles.findingGroupCount}>{group.findings.length}</span>
          </h4>
          <ul className={styles.findingItems}>
            {group.findings.map((finding, index) => (
              <li
                key={`${group.severity ?? "ungraded"}-${index}`}
                className={styles.findingItem}
                data-malformed={finding.malformed || undefined}
              >
                {/* A finding's text is written by a reviewer and routinely
                    carries a path in backticks or a quoted line, so it is
                    markdown. `inline` density: it sits inside a list item
                    and must not open block margins mid-list. */}
                <Markdown source={finding.text} density="inline" />
                {finding.where !== null && (
                  <span className={styles.findingWhere}>{finding.where}</span>
                )}
                {/* A stored entry that did not satisfy the finding shape is
                    shown and marked, never dropped: a findings list is the
                    material for "is this safe to merge", and quietly showing
                    four of five gives a confident answer built on a list the
                    reader believes is whole. */}
                {finding.malformed && (
                  <span className={styles.findingMalformed}>
                    This entry is not a well-formed finding — shown as stored.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
