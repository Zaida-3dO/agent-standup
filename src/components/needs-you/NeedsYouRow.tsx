// One row in the `/needs-you` inbox — the reason, the waiting age, and the
// control that actually ends the wait.
//
// **The control is chosen by reason, not shared across them.** A decision
// row gets approve/reject buttons whose verbs name the specific act
// (`DECISION_LABELS`); a `blocked_on_you` row gets a reply box, because it
// is waiting on an answer rather than a decision. See `respond.ts`'s header
// for why collapsing these into one comment box would leave every item
// exactly as held as it was.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree it returns — this repo's harness runs `environment:
// "node"` with no DOM (`tests/helpers/react-element.ts`). The reply box's
// text therefore lives in the parent's state and arrives as a prop.
import Link from "next/link";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { RESPONSE_KIND_BY_REASON } from "@/lib/needs-you/respond";
import {
  DECISION_LABELS,
  REASON_LABELS,
  REASON_PROMPTS,
  canDecide,
  linksToReviews,
  shortSha,
  waitingFor,
} from "@/lib/needs-you/view";
import styles from "./NeedsYouInbox.module.css";

export interface NeedsYouRowProps {
  readonly item: NeedsYouItem;
  readonly now: number;
  /** In flight for THIS item — disables its controls so a double click cannot fire twice. */
  readonly busy: boolean;
  readonly onApprove: (itemId: string) => void;
  readonly onReject: (itemId: string) => void;
  readonly onAnswer: (itemId: string) => void;
  readonly onGrantStanding: (itemId: string) => void;
  /** The reply text for this row, held by the container so this stays hook-free. */
  readonly replyText: string;
  readonly onReplyTextChange: (itemId: string, value: string) => void;
  /**
   * Whether the standing grant is awaiting confirmation on this row.
   *
   * Held by the container for the same reason `replyText` is — this
   * component stays hook-free so a test can call it as a function and read
   * the element tree back. See the module header.
   */
  readonly standingPending: boolean;
  /** Arms the confirm step, or stands it back down. */
  readonly onStandingPendingChange: (itemId: string, pending: boolean) => void;
}

export function NeedsYouRow({
  item,
  now,
  busy,
  onApprove,
  onReject,
  onAnswer,
  onGrantStanding,
  replyText,
  onReplyTextChange,
  standingPending,
  onStandingPendingChange,
}: NeedsYouRowProps) {
  const responseKind = RESPONSE_KIND_BY_REASON[item.reason];
  const itemHref = `/items/${encodeURIComponent(item.id)}`;
  // Every approval affordance links to the findings behind it. `#reviews`
  // is the Reviews tab's deep-linkable hash (`@/lib/item-detail/tabs`'s
  // `hashForTab`), read by the detail page on load. `linksToReviews` is
  // shared with the digest's `NeedsYouBlock` so both send a reader to the
  // same place for the same item.
  const detailHref = linksToReviews(item) ? `${itemHref}#reviews` : itemHref;
  const decidable = canDecide(item);
  const labels = DECISION_LABELS[item.reason];
  const sha = shortSha(item.tipCommitSha);
  const replyId = `needs-you-reply-${item.id}`;

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
        <span className={styles.prompt}>{REASON_PROMPTS[item.reason]}</span>
      </div>

      <div className={styles.rowMeta}>
        <span className={styles.waiting} title={item.updatedAt}>
          waiting {waitingFor(item, now)}
        </span>

        {responseKind === "decision" ? (
          <div className={styles.actions}>
            <Link className={styles.reviewLink} href={detailHref}>
              See findings
            </Link>
            {/* What the decision is pinned to, shown rather than implied —
                an approval names a commit, and a person authorising one
                should be able to see which. */}
            {sha !== null && (
              <span className={styles.commit} title={item.tipCommitSha ?? undefined}>
                at {sha}
              </span>
            )}
            {decidable ? (
              <>
                <button
                  type="button"
                  className={styles.approve}
                  disabled={busy}
                  onClick={() => onApprove(item.id)}
                >
                  {labels?.approve ?? "Approve"}
                </button>
                {labels?.reject != null && (
                  <button
                    type="button"
                    className={styles.deny}
                    disabled={busy}
                    onClick={() => onReject(item.id)}
                  >
                    {labels.reject}
                  </button>
                )}
              </>
            ) : (
              // Stands exactly where the approve button would be, rather
              // than leaving a gap the reader has to interpret. An approval
              // here names a commit and the item has none, so the control is
              // withheld and the reason given in its place.
              //
              // The icon is not decoration: the explanation was carried by
              // dim colour alone, which put it below AA for body text and
              // made the one thing explaining a missing control the
              // faintest thing on the row.
              <span className={styles.notYet}>
                <span className={styles.notYetIcon} aria-hidden="true">
                  ○
                </span>
                No commit recorded yet — nothing to approve yet
              </span>
            )}
          </div>
        ) : (
          <div className={styles.actions}>
            <Link className={styles.reviewLink} href={detailHref}>
              Open item
            </Link>
          </div>
        )}
      </div>

      {/* The reply box for a question. Full width under the row rather than
          inline beside the meta, because an answer is prose and a one-line
          input invites a one-word answer to a question that deserves more. */}
      {responseKind === "answer" && (
        <div className={styles.reply}>
          <label className={styles.replyLabel} htmlFor={replyId}>
            Your answer
          </label>
          <textarea
            id={replyId}
            className={styles.replyInput}
            value={replyText}
            rows={2}
            disabled={busy}
            placeholder="Answer the question holding this up…"
            onChange={(event) => onReplyTextChange(item.id, event.target.value)}
          />
          <button
            type="button"
            className={styles.approve}
            disabled={busy || replyText.trim() === ""}
            onClick={() => onAnswer(item.id)}
          >
            Send answer
          </button>
        </div>
      )}

      {/* The standing grant — a separate act, in its own region.
          "Approve this once" and "always approve this kind" are different
          acts, and this one removes the hold for whatever the item later
          becomes, so it must never be mistakable for the button beside it.

          **Quiet is not the same as invisible, and the difference matters
          most when the one-time approval is absent.** With no commit to
          approve, this is the only control on the row — so styling it as
          underlined text made the broadest, least reversible decision the
          faintest thing on the card, and made it look like the links it
          sits among. It now reads as a button, sits in its own region away
          from the links and the status text, and asks once before it acts.

          Offered only where it applies: an item that does not need a
          person's merge authority has no hold for it to lift. */}
      {item.reason === "needs_approval" && (
        <div className={styles.standingRegion}>
          {standingPending ? (
            <>
              <span className={styles.standingPrompt}>
                Always approve <strong>{item.title}</strong>? Future work on it merges without
                asking you again. You can change this on the item at any time.
              </span>
              <span className={styles.standingConfirmRow}>
                <button
                  type="button"
                  className={styles.standingConfirm}
                  disabled={busy}
                  onClick={() => onGrantStanding(item.id)}
                >
                  Yes, always approve it
                </button>
                <button
                  type="button"
                  className={styles.standingCancel}
                  disabled={busy}
                  onClick={() => onStandingPendingChange(item.id, false)}
                >
                  Cancel
                </button>
              </span>
            </>
          ) : (
            <button
              type="button"
              className={styles.standing}
              disabled={busy}
              onClick={() => onStandingPendingChange(item.id, true)}
              title="Sets this item's merge authority to pre-approved, so future work on it merges without asking you again."
            >
              Always approve this item — don&apos;t ask again
            </button>
          )}
        </div>
      )}
    </li>
  );
}
