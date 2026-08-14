// One event line in the "since your last visit" list — MILESTONES.md #38.
//
// Hook-free and prop-driven, like every other component in this repo, so a
// test can call it as a function and inspect the element tree it returns
// (`tests/helpers/react-element.ts`); see `TopBar.tsx`'s header for the full
// reasoning.
import type { SinceEvent } from "@/lib/since/types";
import { actorLabel, eventSummary } from "@/lib/since/view";
import styles from "./SinceLastVisit.module.css";

export interface EventRowProps {
  readonly event: SinceEvent;
  /** Marks this one seen. Absent when no profile is active — there is nobody to mark it for. */
  readonly onMarkSeen?: (eventId: string) => void;
}

/**
 * The timestamp, as a short local time.
 *
 * Falls back to the raw string if the date does not parse rather than
 * rendering "Invalid Date" — a malformed timestamp should cost the reader
 * a less pretty line, not make the row look broken.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function EventRow({ event, onMarkSeen }: EventRowProps) {
  const rowClass = `${styles.event} ${event.seen ? "" : styles.unseen}`.trim();

  return (
    <li className={rowClass} data-seen={event.seen} data-event-id={event.id}>
      <span className={styles.actor}>{actorLabel(event)}</span>
      <span className={styles.summary}>{eventSummary(event)}</span>
      <time className={styles.timestamp} dateTime={event.ts}>
        {formatTimestamp(event.ts)}
      </time>
      {/* "Someone else has already looked at this" — shown only when it is
          not also true of you, because beside your own seen row it would be
          noise. See `get_events`'s header on why the two are separate. */}
      {!event.seen && event.seenByAnyone && (
        <span className={styles.seenByOther}>seen by someone else</span>
      )}
      {event.body && <p className={styles.body}>{event.body}</p>}
      {/* Only an unseen row offers the action, and only when there is a
          profile to attribute it to. Offering "mark as seen" on something
          already seen is a button whose only possible effect is nothing. */}
      {!event.seen && onMarkSeen && (
        <button
          type="button"
          className={styles.markOne}
          onClick={() => onMarkSeen(event.id)}
          aria-label={`Mark as seen: ${eventSummary(event)}`}
        >
          Mark seen
        </button>
      )}
    </li>
  );
}
