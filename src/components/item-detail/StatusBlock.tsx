// The status block — everything *"why is this stuck"* needs, above the
// fold, before any prose.
//
// **The whole task is that none of this is new data.** State, ownership,
// what it is waiting on, how long it has sat and where it got to were all
// already in the detail payload, and answering the question meant scrolling
// a long page and inferring from a ledger. This block puts them in one
// place, in the order the question is actually asked: what is it, who has
// it, what is it waiting on, how long has it been like this, where did it
// get to, what was left open.
//
// Hook-free and prop-driven, so this repo's DOM-free harness calls it as a
// function and walks the tree it returns (`tests/helpers/react-element.ts`).
// Every derivation lives in `@/lib/item-detail/status`; this file decides
// only how the answers look.
//
// **`now` is a prop, not `Date.now()`.** An age is the one thing here that
// changes without the data changing, and a component that read the clock
// itself would be non-deterministic, would mismatch between the server's
// HTML and the first client render, and would need the clock frozen to be
// tested at all. The caller — which already knows what "now" means for its
// screen — passes it in, exactly as `StalenessDot` takes a duration rather
// than a timestamp.
import { StalenessDot } from "@/components/chips/StalenessDot";
import { StateChip } from "@/components/chips/StateChip";
import { PriorityChip } from "@/components/chips/PriorityChip";
import type { ItemState } from "@/lib/board/types";
import type { Priority } from "@/lib/design/tokens";
import { columnTitle } from "@/lib/board/view";
import { showsOwnState } from "@/lib/item-detail/view";
import {
  blockedLabel,
  livenessPresentation,
  roleLabel,
  type BlockedOn,
  type StatusSummary,
} from "@/lib/item-detail/status";
import type { BoardColumnId, DetailAssignment, DetailItem } from "@/lib/item-detail/types";
import type { OpenLoop } from "@/lib/open-loops";
import styles from "./StatusBlock.module.css";

export interface StatusBlockProps {
  readonly item: DetailItem;
  readonly column: BoardColumnId;
  readonly status: StatusSummary;
  /** What the caller means by "now", in epoch ms — see the header. */
  readonly now: number;
}

export function StatusBlock({ item, column, status, now }: StatusBlockProps) {
  return (
    <section className={styles.block} data-status-block aria-label="Status and ownership">
      <div className={styles.chips}>
        {/* A project's own `state` is a creation leftover (DECISIONS.md
            §13c), so it is suppressed rather than printed as fact — the
            derived column below is the honest position. Same rule the
            header applies, via the same function. */}
        {showsOwnState(item.kind) && <StateChip state={item.state as ItemState} />}
        <PriorityChip priority={item.priority as Priority} />
        <span className={styles.column} data-column={column}>
          {columnTitle(column)}
        </span>
        <span className={styles.kind}>{item.kind}</span>
        {/* Renders nothing under 4h, by design — an indicator on every item
            is an indicator on no item. See `StalenessDot`'s header. */}
        <StalenessDot ageMs={status.ageMs} />
      </div>

      {ownership(status.holders, status.previousHolders)}

      {status.blocked !== null && blocked(status.blocked, now)}

      {checkpoint(status.checkpoint)}

      {loops(status.loops)}
    </section>
  );
}

/**
 * Who holds it, and who held it before.
 *
 * **An unheld item says so in a sentence.** Rendering nothing would be
 * indistinguishable from a section that failed to load, and "nobody holds
 * this" is a genuine and important answer to "why is this stuck" — very
 * often it is the whole answer.
 */
function ownership(holders: readonly DetailAssignment[], previous: readonly DetailAssignment[]) {
  return (
    <div className={styles.row} data-region="ownership">
      <span className={styles.rowLabel}>Held by</span>
      {holders.length === 0 ? (
        <p className={styles.none} data-unowned>
          Nobody holds this right now.
        </p>
      ) : (
        <ul className={styles.holders}>
          {holders.map((holder) => (
            <li key={holder.id} className={styles.holder} data-holder-id={holder.holderId}>
              {liveness(holder.liveness, holder.displayName)}
              <span className={styles.holderName}>{holder.displayName}</span>
              <span className={styles.role}>{roleLabel(holder)}</span>
              <span>since {holder.claimedAt}</span>
              <span>last active {holder.lastActive}</span>
              {facts(holder)}
            </li>
          ))}
        </ul>
      )}
      {previous.length > 0 && (
        <div className={styles.previous} data-region="previous-holders">
          <span className={styles.rowLabel}>Earlier holders</span>
          <ul className={styles.previousList}>
            {previous.map((holder) => (
              <li key={holder.id} data-previous-holder-id={holder.holderId}>
                <span className={styles.holderName}>{holder.displayName}</span>{" "}
                <span className={styles.role}>{roleLabel(holder)}</span>{" "}
                {/* The release time is the point of this list. "Who had it
                    before" without "and when did they let go" cannot tell a
                    handover an hour ago from one three weeks ago, which is
                    the difference between a live thread and a cold one. */}
                <span data-released-at={holder.releasedAt ?? undefined}>
                  {holder.releasedAt === null
                    ? "release time not recorded"
                    : `released ${holder.releasedAt}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Machine, branch and model — where the work is actually happening. Omitted when unrecorded. */
function facts(assignment: DetailAssignment) {
  const entries: string[] = [assignment.machine];
  if (assignment.branch !== null) entries.push(assignment.branch);
  if (assignment.model !== null) entries.push(assignment.model);
  return (
    <span className={styles.facts} data-facts>
      {entries.map((entry) => (
        <span key={entry}>{entry}</span>
      ))}
    </span>
  );
}

/**
 * The liveness dot — four values, four shapes.
 *
 * The shape is the load-bearing channel and the colour is the second one.
 * `stalled` and `dead` are the pair most likely to collapse into each other
 * in greyscale or for a colour-blind reader, and telling them apart is
 * exactly what decides whether somebody steps in.
 */
function liveness(value: string, name: string) {
  const presentation = livenessPresentation(value);
  const shapeClass =
    presentation.shape === "filled"
      ? styles.shapeFilled
      : presentation.shape === "half"
        ? styles.shapeHalf
        : presentation.shape === "hollow"
          ? styles.shapeHollow
          : styles.shapeRing;
  const label = `${name} is ${presentation.word}`;
  return (
    <>
      <span
        className={`${styles.livenessDot} ${shapeClass}`}
        data-liveness={value}
        role="img"
        aria-label={label}
        title={presentation.hint}
      />
      {/* The word as well as the dot. A dot alone puts the whole signal in
          a channel a reader may not have, and this one is the difference
          between "still working" and "gone". */}
      <span className={styles.livenessWord} aria-hidden="true">
        {presentation.word}
      </span>
    </>
  );
}

/**
 * What the item is blocked on — and the three kinds told apart.
 *
 * `person` is somebody's to unblock and belongs in their queue;
 * `external_process` is nobody's and resolves when something outside
 * answers; `time` resolves on its own and needs no action at all. One
 * "blocked" treatment for all three puts the item that needs a decision
 * beside the one waiting on a clock, which makes a blocked list unreadable
 * in the case it matters most.
 */
function blocked(value: BlockedOn, now: number) {
  const kindClass =
    value.kind === "person"
      ? styles.blockedPerson
      : value.kind === "external_process"
        ? styles.blockedExternal
        : value.kind === "time"
          ? styles.blockedTime
          : styles.blockedUnspecified;

  return (
    <div
      className={`${styles.blocked} ${kindClass}`}
      data-region="blocked"
      data-blocked-on-type={value.kind}
    >
      <span className={styles.blockedKind}>{blockedLabel(value.kind)}</span>
      {value.kind === "person" && value.personId !== null && (
        <span data-blocked-on-person-id={value.personId}>{value.personId} must act.</span>
      )}
      {value.kind === "time" && (
        <span data-unblock-at={value.unblockAt ?? undefined}>
          {value.unblockAt === null
            ? "No unblock time recorded."
            : // Past its own unblock time and still blocked is a fact worth
              // stating outright: it means the clock ran out and nothing
              // picked the item back up, which reads as "waiting" but is
              // really "stuck".
              `${Date.parse(value.unblockAt) <= now ? "Was due" : "Unblocks"} ${value.unblockAt}.`}
        </span>
      )}
      {value.reason !== null && <span className={styles.blockedReason}>{value.reason}</span>}
    </div>
  );
}

/** The newest checkpoint's one-line BLUF — the "where is this up to" line. */
function checkpoint(value: StatusSummary["checkpoint"]) {
  return (
    <div className={styles.row} data-region="checkpoint">
      <span className={styles.rowLabel}>Where it is</span>
      {value === null ? (
        <p className={styles.none}>No checkpoint yet — nobody has recorded where this got to.</p>
      ) : (
        <p className={styles.checkpoint}>
          {value.headline}
          <span className={styles.checkpointWhen}>{value.ts}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The loops still open — the things somebody meant to come back to.
 *
 * An open loop is by definition unfinished, so a loop recorded but never
 * rendered is a loose end nobody is holding. A closed loop is absent rather
 * than struck through: the fold has already resolved it, and listing
 * resolved loops would bury the open ones in the list that exists to
 * surface them.
 */
function loops(value: readonly OpenLoop[]) {
  return (
    <div className={styles.row} data-region="open-loops">
      <span className={styles.rowLabel}>Open loops</span>
      {value.length === 0 ? (
        <p className={styles.none}>No open loops.</p>
      ) : (
        <ul className={styles.loops}>
          {value.map((loop) => (
            <li key={loop.loopId} className={styles.loop} data-loop-id={loop.loopId}>
              <span className={styles.loopMark} aria-hidden="true" />
              <span>{loop.text}</span>
              <span className={styles.loopWhen}>opened {loop.openedAt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
