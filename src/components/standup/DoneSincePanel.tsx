// The Standup home's reassurance panel: what was finished since the evening
// before, newest first, with the project and the time of day. A footer link
// goes on to the activity log for the rest.
import Link from "next/link";
import type { DoneView } from "@/lib/standup/view";
import { SectionError, countText } from "./StandupParts";
import styles from "./Standup.module.css";

export interface DoneSincePanelProps {
  readonly view: DoneView;
  /** "yesterday evening" or "this evening": completes the panel's title. */
  readonly sinceLabel: string;
  readonly onRetry: () => void;
}

const HEADING_ID = "standup-done-heading";

export function DoneSincePanel({ view, sinceLabel, onRetry }: DoneSincePanelProps) {
  const title = `Done since ${sinceLabel}`;
  if (view.status === "error") {
    return <SectionError title={title} message={view.message} onRetry={onRetry} />;
  }

  return (
    <section className={`${styles.panel} ${styles.done}`} aria-labelledby={HEADING_ID}>
      <div className={styles.panelHead}>
        <h2 id={HEADING_ID} className={styles.panelTitle}>
          {title}
        </h2>
        {!view.empty && (
          <span className={`${styles.count} ${styles.countDone}`}>{countText(view.total)}</span>
        )}
      </div>
      {view.empty ? (
        <p className={styles.faintLine}>Nothing finished since {sinceLabel}.</p>
      ) : (
        <ul className={styles.doneList}>
          {view.rows.map((row, index) => (
            <li key={row.itemId ?? `row-${index}`} className={styles.doneRow}>
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>
              <span className={styles.doneMain}>
                {row.href !== null ? (
                  <Link href={row.href} className={styles.doneTitle}>
                    {row.title}
                  </Link>
                ) : (
                  <span className={styles.doneTitle}>{row.title}</span>
                )}
                {row.project !== null && (
                  <span className={styles.doneProject}>{row.project.title}</span>
                )}
              </span>
              <span className={styles.doneTime}>{row.time}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.panelFoot}>
        <Link href="/activity" className={styles.footLink}>
          {view.footerText} <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
