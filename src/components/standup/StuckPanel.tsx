// The Standup home's Stuck panel: work waiting on something outside, or whose
// agent stopped responding. Not the reader's job to fix, but worth knowing.
// Rendered only when there is something to say: an empty list is no panel.
import Link from "next/link";
import type { StuckView } from "@/lib/standup/view";
import { ProjectChip, SectionError, countText } from "./StandupParts";
import styles from "./Standup.module.css";

export interface StuckPanelProps {
  readonly view: StuckView;
  readonly onRetry: () => void;
}

const HEADING_ID = "standup-stuck-heading";

/** Whether the panel renders at all, so the page can skip the grid area it would have taken. */
export function showsStuck(view: StuckView): boolean {
  return view.status === "error" || view.rows.length > 0;
}

export function StuckPanel({ view, onRetry }: StuckPanelProps) {
  if (view.status === "error") {
    return <SectionError title="Stuck" message={view.message} onRetry={onRetry} />;
  }
  if (view.rows.length === 0) return null;

  return (
    <section className={`${styles.panel} ${styles.stuck}`} aria-labelledby={HEADING_ID}>
      <div className={styles.panelHead}>
        <h2 id={HEADING_ID} className={styles.panelTitle}>
          Stuck
        </h2>
        <span className={`${styles.count} ${styles.countStuck}`}>{countText(view.count)}</span>
      </div>
      <ul className={styles.stuckList}>
        {view.rows.map((row) => (
          <li key={row.id} className={styles.stuckRow}>
            <Link href={row.href} className={styles.stuckTitle}>
              {row.title}
            </Link>
            <p className={styles.why}>{row.why}</p>
            {(row.project !== null || row.age !== null) && (
              <div className={styles.stuckMeta}>
                {row.project !== null && <ProjectChip project={row.project} />}
                {row.age !== null && <span className={styles.age}>{row.age}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
