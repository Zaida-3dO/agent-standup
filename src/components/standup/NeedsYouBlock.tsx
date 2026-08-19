// The Standup home's "Needs you" block — a count and the top few, linking
// to the full inbox at `/needs-you`. Hook-free and prop-driven; see
// `TopBar.tsx`'s header for the reasoning every component here follows.
import Link from "next/link";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { REASON_LABELS, isDecidable, sortByWaiting, waitingFor } from "@/lib/needs-you/view";
import { EmptyState } from "@/components/states";
import styles from "./Standup.module.css";

/**
 * Where a row's title links. `#reviews` (the item detail's deep-linkable
 * Reviews tab hash) only for a decidable reason — `blocked_on_you` has no
 * review artifact to point at, so its link goes to the item itself. Mirrors
 * `NeedsYouRow` (`@/components/needs-you/NeedsYouRow.tsx`) exactly, so the
 * same item links to the same place whether a reader reaches it from this
 * preview or from the full inbox.
 */
function itemHref(item: NeedsYouItem): string {
  const base = `/items/${encodeURIComponent(item.id)}`;
  return isDecidable(item) ? `${base}#reviews` : base;
}

export interface NeedsYouBlockProps {
  readonly items: readonly NeedsYouItem[];
  readonly now: number;
  /** How many rows to show before "See all" takes over — the rest still count. */
  readonly previewCount?: number;
}

export function NeedsYouBlock({ items, now, previewCount = 4 }: NeedsYouBlockProps) {
  const sorted = sortByWaiting(items);
  const preview = sorted.slice(0, previewCount);

  return (
    <section className={styles.block} aria-label="Needs you">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>Needs you</h2>
        {items.length > 0 && (
          <span className={styles.blockCount} aria-label={`${items.length} items`}>
            {items.length}
          </span>
        )}
      </div>

      {preview.length === 0 ? (
        <EmptyState kind="empty" noun="item" title="Nothing needs you right now" />
      ) : (
        <ul className={styles.needsYouList}>
          {preview.map((item) => (
            <li key={item.id} className={styles.needsYouRow}>
              <Link href={itemHref(item)} className={styles.itemLink}>
                {item.title}
              </Link>
              <span className={styles.needsYouMeta}>
                {REASON_LABELS[item.reason]} · waiting {waitingFor(item, now)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link href="/needs-you" className={styles.seeAll}>
        {items.length > preview.length ? `See all ${items.length}` : "Open needs you"}
      </Link>
    </section>
  );
}
