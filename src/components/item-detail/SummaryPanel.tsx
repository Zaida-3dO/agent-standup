// The completion summary — MILESTONES.md #72's fourth piece.
//
// Hook-free and prop-driven; see `SubtaskTree.tsx`'s header.
//
// Renders nothing at all when there is no summary. A summary exists only
// once an item has been completed (SCHEMA.md §5a), so an in-progress item
// shows no section rather than an empty one headed "Summary" — the same
// reasoning `NeedsYouBadge` gives for rendering nothing at zero.
import type { DetailSummary } from "@/lib/item-detail/types";
import { summaryEntries } from "@/lib/item-detail/view";
import styles from "./ItemDetail.module.css";

export interface SummaryPanelProps {
  readonly summary: DetailSummary | null;
}

/**
 * One labelled group of summary entries, or nothing when there are none —
 * a heading over an empty list says less than no heading at all.
 *
 * A plain function returning an element rather than a nested component,
 * deliberately. A nested component would be a *reference* in the returned
 * tree, not its output, so this repo's DOM-free technique (calling a
 * component and walking what it returned) could not see inside it — the
 * groups would be untestable without a renderer this harness does not have.
 */
function entryGroup(label: string, value: unknown) {
  const entries = summaryEntries(value);
  if (entries.length === 0) return null;
  return (
    <div className={styles.summaryGroup} data-group={label}>
      <p className={styles.summaryLabel}>{label}</p>
      <ul className={styles.summaryList}>
        {entries.map((entry, index) => (
          <li key={`${label}-${index}`}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

export function SummaryPanel({ summary }: SummaryPanelProps) {
  if (summary === null) return null;

  return (
    <section className={styles.section} aria-label="Summary">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Summary</h2>
        <span className={styles.progress}>
          {summary.userFacing ? "User-facing" : "Not user-facing"}
        </span>
      </header>
      {entryGroup("Shipped", summary.shipped)}
      {entryGroup("Not done", summary.notDone)}
      {entryGroup("What to test", summary.whatToTest)}
      {entryGroup("Watch for", summary.watchFor)}
      {/* `how_verified` is required exactly when the work is not
          user-facing (SCHEMA.md §5a), so it is the answer to "how do we
          know this works if nobody can see it" and belongs beside the
          user-facing flag rather than buried in a list. */}
      {summary.howVerified !== null && (
        <div className={styles.summaryGroup} data-group="How verified">
          <p className={styles.summaryLabel}>How verified</p>
          <p className={styles.artifactBody}>{summary.howVerified}</p>
        </div>
      )}
    </section>
  );
}
