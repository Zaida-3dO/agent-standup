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
  /** The id of the item whose response is in flight, or null — disables only that row's controls. */
  readonly busyId: string | null;
  readonly onApprove: (itemId: string) => void;
  readonly onReject: (itemId: string) => void;
  readonly onAnswer: (itemId: string) => void;
  readonly onGrantStanding: (itemId: string) => void;
  /** Per-row reply text, keyed by item id — held here so the row stays hook-free. */
  readonly replyTexts: Readonly<Record<string, string>>;
  readonly onReplyTextChange: (itemId: string, value: string) => void;
  /** Which rows have armed the standing grant's confirm step. */
  readonly standingPending: Readonly<Record<string, boolean>>;
  readonly onStandingPendingChange: (itemId: string, pending: boolean) => void;
  /** A response's own failure, surfaced above the list without discarding what already loaded. */
  readonly respondError: string | null;
  /** Confirmation that the last response landed — an action with no visible result reads as a no-op. */
  readonly respondNotice: string | null;
}

export function NeedsYouInboxView({
  loadState,
  now,
  busyId,
  onApprove,
  onReject,
  onAnswer,
  onGrantStanding,
  replyTexts,
  onReplyTextChange,
  standingPending,
  onStandingPendingChange,
  respondError,
  respondNotice,
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
          Blocked on you, plans awaiting approval, work waiting for you to look at it, and merges
          waiting on your sign-off — answer each one here.
        </p>
      </div>

      {respondError && (
        <p className={styles.decideError} role="alert">
          {respondError}
        </p>
      )}

      {respondNotice && (
        <p className={styles.decideNotice} role="status">
          {respondNotice}
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
              busy={busyId === item.id}
              onApprove={onApprove}
              onReject={onReject}
              onAnswer={onAnswer}
              onGrantStanding={onGrantStanding}
              replyText={replyTexts[item.id] ?? ""}
              onReplyTextChange={onReplyTextChange}
              standingPending={standingPending[item.id] ?? false}
              onStandingPendingChange={onStandingPendingChange}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
