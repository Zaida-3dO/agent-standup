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
              // Disabled with the reason stated, rather than offered and
              // failing server-side: these kinds pin a commit, and the item
              // has none to pin to.
              <span className={styles.notYet}>No commit recorded yet — nothing to approve</span>
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

      {/* The standing grant — deliberately the quietest control on the row.
          "Approve this once" and "always approve this kind" are different
          acts, and this one removes the hold for whatever the item later
          becomes, so it must never be mistakable for the button beside it.
          Offered only where it applies: an item that does not need a
          person's merge authority has no hold for it to lift. */}
      {item.reason === "needs_approval" && (
        <button
          type="button"
          className={styles.standing}
          disabled={busy}
          onClick={() => onGrantStanding(item.id)}
          title="Sets this item's merge authority to pre-approved, so future work on it merges without asking you again."
        >
          Always approve this item — don&apos;t ask again
        </button>
      )}
    </li>
  );
}
