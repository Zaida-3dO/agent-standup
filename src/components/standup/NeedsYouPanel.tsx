// The Standup home's lead panel: what only the reader can decide. One row per
// item (a title, the project, one line on what is asked, how long it has
// waited, and a verb button), or a single calm line when nothing needs them.
// Both the title and the button open the item: nothing is answered here.
import Link from "next/link";
import type { NeedsYouView } from "@/lib/standup/view";
import { ProjectChip, SectionError } from "./StandupParts";
import styles from "./Standup.module.css";

export interface NeedsYouPanelProps {
  readonly view: NeedsYouView;
  readonly onRetry: () => void;
}

const HEADING_ID = "standup-needs-heading";

export function NeedsYouPanel({ view, onRetry }: NeedsYouPanelProps) {
  if (view.status === "error") {
    return <SectionError title="Needs you" message={view.message} onRetry={onRetry} />;
  }

  if (view.quiet) {
    return (
      <section className={styles.allClear} aria-labelledby={HEADING_ID} data-quiet="true">
        <span className={styles.tick} aria-hidden="true">
          ✓
        </span>
        <div>
          <h2 id={HEADING_ID} className={styles.allClearTitle}>
            Nothing needs you right now.
          </h2>
          <p className={styles.allClearText}>
            Everything below is moving on its own. Anything that needs you will appear here first.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={`${styles.panel} ${styles.needs}`} aria-labelledby={HEADING_ID}>
      <div className={styles.panelHead}>
        <h2 id={HEADING_ID} className={styles.panelTitle}>
          Needs you
        </h2>
        <span className={`${styles.count} ${styles.countHot}`}>{view.total}</span>
        {view.hasMore && (
          <Link href="/needs-you" className={styles.headLink}>
            Open the full list
          </Link>
        )}
      </div>
      <ul className={styles.needsList}>
        {view.rows.map((row) => (
          <li key={row.id} className={styles.needsRow}>
            <div className={styles.needsMain}>
              <div className={styles.needsTop}>
                {row.project !== null && <ProjectChip project={row.project} />}
                <Link href={row.href} className={styles.needsTitle}>
                  {row.title}
                </Link>
              </div>
              <p className={styles.ask}>{row.ask}</p>
            </div>
            {row.waiting !== null && (
              <span
                className={row.waitingLong ? `${styles.wait} ${styles.waitLong}` : styles.wait}
                data-long={row.waitingLong ? "true" : undefined}
              >
                {row.waiting}
              </span>
            )}
            <Link href={row.href} className={styles.btn} aria-label={`${row.verb}: ${row.title}`}>
              {row.verb}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
