// The Standup home's overnight report — "since 18:00 yesterday: N merged, N
// blocked, ~$X" — over `buildOvernightReport`'s output
// (`@/lib/standup/overnight.ts`). Hook-free and prop-driven; see
// `TopBar.tsx`'s header.
import type { OvernightReport } from "@/lib/standup/overnight";
import styles from "./Standup.module.css";

export interface OvernightBlockProps {
  readonly report: OvernightReport;
  readonly now: number;
}

/** `$12.34`, or nothing at all when nothing could be priced — see `totalCost`'s own null-vs-zero rule. */
function formatCost(cost: number | null): string | null {
  if (cost === null) return null;
  return `~$${cost.toFixed(2)}`;
}

/**
 * A short "since HH:MM" label from an ISO cutoff, in the reader's local
 * time, with a day qualifier when the cutoff falls on a different calendar
 * date from `now`. Takes `now` rather than reading the clock, so this stays
 * testable without freezing time globally — matching `relativeTime`
 * (`@/lib/projects/view.ts`).
 */
function sinceLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "recently";
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const sameCalendarDate = new Date(now).toDateString() === date.toDateString();
  const qualifier = sameCalendarDate ? "" : ", the previous calendar day";
  return `since ${hours}:${minutes}${qualifier}`;
}

export function OvernightBlock({ report, now }: OvernightBlockProps) {
  const cost = formatCost(report.cost);

  return (
    <section className={styles.block} aria-label="Since your last visit">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>Overnight</h2>
        <span className={styles.blockSubtitle}>{sinceLabel(report.since, now)}</span>
      </div>

      <dl className={styles.overnightStats}>
        <div className={styles.stat}>
          <dt>Merged</dt>
          <dd data-stat="merged">{report.merged.length}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Newly blocked</dt>
          <dd data-stat="blocked">{report.newlyBlocked.length}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Dead or stalled now</dt>
          <dd data-stat="dead-stalled">{report.deadOrStalledNow}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Spend</dt>
          <dd data-stat="cost">{cost ?? "—"}</dd>
        </div>
      </dl>

      {report.eventsTruncated && (
        <p className={styles.overnightNote}>
          More may have happened before this window than shown — the activity ledger read reached
          its page limit before the cutoff.{" "}
          <a href="/activity" className={styles.itemLink}>
            See the full ledger
          </a>
          .
        </p>
      )}
      {cost === null && (
        <p className={styles.overnightNote}>
          Spend shows &ldquo;&mdash;&rdquo; because there was either no run in this window or none
          of it could be priced (no rate configured for the models used).
        </p>
      )}
    </section>
  );
}
