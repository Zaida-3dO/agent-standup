// One row in the `/needs-you` inbox — the reason, the waiting age, and the
// decide affordance, exactly as the task's brief lays out.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree it returns — this repo's harness runs `environment:
// "node"` with no DOM (`tests/helpers/react-element.ts`).
import Link from "next/link";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { REASON_LABELS, isDecidable, waitingFor } from "@/lib/needs-you/view";
import styles from "./NeedsYouInbox.module.css";

export interface NeedsYouRowProps {
  readonly item: NeedsYouItem;
  readonly now: number;
  /** In flight for THIS item's decision — disables both buttons so a double click cannot fire twice. */
  readonly deciding: boolean;
  readonly onApprove: (itemId: string) => void;
  readonly onDeny: (itemId: string) => void;
}

export function NeedsYouRow({ item, now, deciding, onApprove, onDeny }: NeedsYouRowProps) {
  const decidable = isDecidable(item);
  const itemHref = `/items/${encodeURIComponent(item.id)}`;
  // Every approval affordance links to the findings behind it — the task's
  // own constraint. `#reviews` is the Reviews tab's deep-linkable hash
  // (`@/lib/item-detail/tabs`'s `hashForTab`), read by the detail page on
  // load exactly as a chip elsewhere in the app already relies on it doing.
  // Only decidable rows carry it: `blocked_on_you` has no review artifact
  // this row's approval could point at, so its links go to the item itself
  // rather than to a Reviews tab that would have nothing to show.
  const detailHref = decidable ? `${itemHref}#reviews` : itemHref;

  return (
    <li className={styles.row} data-reason={item.reason}>
      <div className={styles.rowMain}>
        <span className={styles.reason} data-reason={item.reason}>
          {REASON_LABELS[item.reason]}
        </span>
        <Link className={styles.title} href={detailHref}>
          {item.title}
        </Link>
        {item.headline && <span className={styles.headline}>{item.headline}</span>}
        {item.blockedReason && <span className={styles.blockedReason}>{item.blockedReason}</span>}
      </div>
      <div className={styles.rowMeta}>
        <span className={styles.waiting} title={item.updatedAt}>
          waiting {waitingFor(item, now)}
        </span>
        {decidable ? (
          <div className={styles.actions}>
            <Link className={styles.reviewLink} href={detailHref}>
              See findings
            </Link>
            <button
              type="button"
              className={styles.approve}
              disabled={deciding}
              onClick={() => onApprove(item.id)}
            >
              Approve
            </button>
            <button
              type="button"
              className={styles.deny}
              disabled={deciding}
              onClick={() => onDeny(item.id)}
            >
              Deny
            </button>
          </div>
        ) : (
          <Link className={styles.reviewLink} href={detailHref}>
            Open item
          </Link>
        )}
      </div>
    </li>
  );
}
