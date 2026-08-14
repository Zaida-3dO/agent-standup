// The history section — MILESTONES.md #72's third piece.
//
// Hook-free and prop-driven; see `SubtaskTree.tsx`'s header.
import type { DetailHistoryEntry } from "@/lib/item-detail/types";
import { humanEventType } from "@/lib/item-detail/view";
import styles from "./ItemDetail.module.css";

export interface HistoryListProps {
  readonly history: readonly DetailHistoryEntry[];
  /** True when the ledger holds more than was returned — see the note on why this is shown. */
  readonly truncated: boolean;
}

/**
 * A timestamp as the list shows it. `toISOString` rather than a locale
 * format on purpose: a locale format renders differently on the server and
 * the client (different time zone, different locale), which React reports
 * as a hydration mismatch. An ISO string is the same on both.
 */
function formatTs(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

export function HistoryList({ history, truncated }: HistoryListProps) {
  return (
    <section className={styles.section} aria-label="History">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>History</h2>
      </header>
      {history.length === 0 ? (
        <p className={styles.empty}>Nothing recorded yet.</p>
      ) : (
        <>
          <ul className={styles.history}>
            {history.map((entry) => (
              <li key={entry.id} className={styles.historyEntry} data-type={entry.type}>
                <span className={styles.historyTs}>{formatTs(entry.ts)}</span>
                <span className={styles.historyType}>{humanEventType(entry.type)}</span>
                {entry.body !== null && <span className={styles.historyBody}>{entry.body}</span>}
              </li>
            ))}
          </ul>
          {/* Said outright rather than left to be inferred from a
              suspiciously round number of rows: a list that silently stops
              at its cap reads as the whole history, and "this is all of it"
              is the one thing a history view must not imply falsely. */}
          {truncated && (
            <p className={styles.truncated}>
              Older entries are not shown — this is the most recent {history.length}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
