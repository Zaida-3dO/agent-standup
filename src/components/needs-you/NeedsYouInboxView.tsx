// `/needs-you` — the presentational half. Load/error/loaded branching plus
// the sorted list, exactly like `SinceLastVisitView`'s split: hook-free and
// prop-driven so this repo's DOM-free harness can call it directly
// (`tests/helpers/react-element.ts`).
import type { NeedsYouLoadState } from "@/lib/needs-you/state";
import { sortByWaiting } from "@/lib/needs-you/view";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { NeedsYouRow } from "./NeedsYouRow";
import styles from "./NeedsYouInbox.module.css";

export interface NeedsYouInboxViewProps {
  readonly loadState: NeedsYouLoadState;
  readonly now: number;
  /** The id of the item whose decision is in flight, or null — disables only that row's buttons. */
  readonly decidingId: string | null;
  readonly onApprove: (itemId: string) => void;
  readonly onDeny: (itemId: string) => void;
  /** A decision's own failure, surfaced above the list without discarding what already loaded. */
  readonly decideError: string | null;
}

export function NeedsYouInboxView({
  loadState,
  now,
  decidingId,
  onApprove,
  onDeny,
  decideError,
}: NeedsYouInboxViewProps) {
  if (loadState.status === "loading") {
    return (
      <section className={styles.panel} aria-label="Needs you">
        <h1 className={styles.title}>Needs you</h1>
        <LoadingState rows={4} label="items that need you" />
      </section>
    );
  }

  if (loadState.status === "error") {
    return (
      <section className={styles.panel} aria-label="Needs you">
        <h1 className={styles.title}>Needs you</h1>
        <ErrorState message={loadState.message} centered />
      </section>
    );
  }

  const items = sortByWaiting(loadState.items);

  return (
    <section className={styles.panel} aria-label="Needs you">
      <div className={styles.head}>
        <h1 className={styles.title}>Needs you</h1>
        <p className={styles.subtitle}>
          Blocked on you, plans awaiting approval, and merges waiting on your sign-off — not
          everything that is paused or blocked on something else.
        </p>
      </div>

      {decideError && (
        <p className={styles.decideError} role="alert">
          {decideError}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState kind="empty" noun="item" title="Nothing needs you right now" />
      ) : (
        <ul className={styles.rows}>
          {items.map((item) => (
            <NeedsYouRow
              key={item.id}
              item={item}
              now={now}
              deciding={decidingId === item.id}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
