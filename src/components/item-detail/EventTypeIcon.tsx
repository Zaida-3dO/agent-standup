// The per-type icon on a history row — M10 T10.
//
// "History … every event renders, always, fully expanded" was the
// complaint the row for this tab quotes, and part of what makes a flat
// ledger unscannable is that every one of the seventeen event types looks
// the same on the page — a timestamp and a word. This is the map from
// `EventType` to a small, recognisable glyph, so a reader's eye can sort
// "sixteen routine field_changes and one escalation" from a glance down
// the column rather than by reading every row.
//
// `lucide-react` rather than a hand-drawn shape like `StateIcon`: these sit
// at ordinary list-icon size (16px) next to real text, not at 10px in a
// chip's own silhouette, which is the exact boundary `StateIcon`'s header
// draws between the two approaches. Named and mapped exactly as
// `NavIcon.tsx` does it, for the same reason: the map lives in the one
// component allowed to import an icon library, so anything typed as
// `EventType` stays free to be imported by code that must not carry one
// (`check:db-imports`-adjacent reasoning — see that module's own header).
import {
  Pencil,
  ArrowRightLeft,
  FileText,
  Hand,
  HandMetal,
  UserCheck,
  Send,
  Inbox,
  MessageSquareText,
  GitMerge,
  CircleDot,
  CircleCheck,
  Bell,
  TriangleAlert,
  SlidersHorizontal,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import type { EventType } from "@/lib/events";

const ICONS: Record<EventType, LucideIcon> = {
  field_change: Pencil,
  state_change: ArrowRightLeft,
  checkpoint: FileText,
  note: MessageSquare,
  claim: Hand,
  release: HandMetal,
  takeover: UserCheck,
  dispatch: Send,
  dispatch_claimed: Inbox,
  review_requested: MessageSquareText,
  review: MessageSquareText,
  merge: GitMerge,
  open_loop: CircleDot,
  open_loop_closed: CircleCheck,
  // The three MILESTONES.md #131-adjacent row names outright as "not
  // equally interesting" — nudge, escalation and takeover are the signals
  // that something needed a human or a supervisor to step in, so all three
  // get the icons that read as "attention", not as routine bookkeeping.
  nudge: Bell,
  escalation: TriangleAlert,
  setting_change: SlidersHorizontal,
};

export interface EventTypeIconProps {
  readonly type: EventType;
}

/**
 * Renders the icon for one history entry's `type`.
 *
 * `aria-hidden`, matching `NavIcon` and `StateIcon`: every row already
 * carries its type as text (`humanEventType`), so the icon is a visual
 * scanning aid, not a second announcement of the same word.
 */
export function EventTypeIcon({ type }: EventTypeIconProps) {
  const Icon = ICONS[type];
  return <Icon size={14} aria-hidden="true" data-event-icon={type} />;
}
