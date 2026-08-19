// The Standup home's "In flight now" block — who is working on what, right
// now, from live assignments on the in-progress column. Hook-free and
// prop-driven; see `TopBar.tsx`'s header.
import Link from "next/link";
import type { BoardEntry, Liveness } from "@/lib/board/types";
import { EmptyState } from "@/components/states";
import styles from "./Standup.module.css";

export interface InFlightBlockProps {
  readonly entries: readonly BoardEntry[];
}

/** One card's holder, flattened out of `entry.assignments` — one row per (item, holder) pair. */
interface InFlightRow {
  readonly itemId: string;
  readonly itemTitle: string;
  readonly displayName: string;
  readonly role: string;
  readonly liveness: Liveness;
}

function flatten(entries: readonly BoardEntry[]): InFlightRow[] {
  const rows: InFlightRow[] = [];
  for (const entry of entries) {
    for (const assignment of entry.assignments) {
      rows.push({
        itemId: entry.item.id,
        itemTitle: entry.item.title,
        displayName: assignment.displayName,
        role: assignment.roleCustom ?? assignment.role.replace(/_/g, " "),
        liveness: assignment.liveness,
      });
    }
  }
  return rows;
}

/** `running` first, then `stalled` — the two liveness values worth noticing on this block; `dead`/`superseded` sink last. */
const LIVENESS_RANK: Readonly<Record<Liveness, number>> = {
  running: 0,
  stalled: 1,
  dead: 2,
  superseded: 3,
};

export function InFlightBlock({ entries }: InFlightBlockProps) {
  const rows = flatten(entries).sort(
    (a, b) => LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness],
  );

  return (
    <section className={styles.block} aria-label="In flight now">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>In flight now</h2>
        {rows.length > 0 && (
          <span className={styles.blockCount} aria-label={`${rows.length} assignments`}>
            {rows.length}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState kind="empty" noun="assignment" title="Nothing is being worked on right now" />
      ) : (
        <ul className={styles.inFlightList}>
          {rows.map((row, index) => (
            <li
              key={`${row.itemId}-${index}`}
              className={styles.inFlightRow}
              data-liveness={row.liveness}
            >
              <span
                className={styles.livenessDot}
                data-liveness={row.liveness}
                aria-hidden="true"
              />
              <div className={styles.inFlightMain}>
                <span className={styles.holder}>
                  {row.displayName}
                  <span className={styles.role}> · {row.role}</span>
                </span>
                <Link href={`/items/${encodeURIComponent(row.itemId)}`} className={styles.itemLink}>
                  {row.itemTitle}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link href="/board" className={styles.seeAll}>
        Open board
      </Link>
    </section>
  );
}
