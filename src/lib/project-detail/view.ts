// The project page's pure logic — every decision the page makes about what
// to show, as plain functions over plain data.
//
// Split out from the components for the reason the whole front end here is:
// the harness runs `environment: "node"` with no DOM, so logic living
// inside a component is only reachable by rendering it, while logic living
// here is callable directly. These are the functions that decide whether a
// project reads as honest or as a lie, so they are the ones that need to be
// directly assertable.
import { ITEM_STATES, STATE_LABELS } from "@/lib/design/tokens";
import type { BoardColumnId, ItemState } from "@/lib/board/types";
import type {
  BlockedDescendant,
  DerivedStateReading,
  ProjectChild,
  ProjectDetail,
  RepairAdvice,
  StateCounts,
} from "./types";

/** Human labels for the four derived columns — the page says "In progress", not `in_progress`. */
export const COLUMN_LABELS: Readonly<Record<BoardColumnId, string>> = {
  backlog: "Backlog",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
};

/** One band of the distribution — a state with at least one child in it. */
export interface DistributionSegment {
  readonly state: ItemState;
  readonly count: number;
  /** Share of the project's children, `0`–`1`. */
  readonly share: number;
}

/**
 * The distribution: every state the project actually has children in, in
 * the vocabulary's own order.
 *
 * Empty states are omitted rather than rendered at zero, and the order is
 * `ITEM_STATES` rather than descending by count — both for the reasons
 * `@/lib/projects/view.ts` gives for the grid's strip, restated here rather
 * than imported because this one returns the same shape for a different
 * consumer and coupling them would mean a change for one silently changing
 * the other.
 */
export function distributionOf(counts: StateCounts, total: number): DistributionSegment[] {
  if (total <= 0) return [];
  const segments: DistributionSegment[] = [];
  for (const state of ITEM_STATES) {
    const count = counts[state] ?? 0;
    if (count <= 0) continue;
    segments.push({ state, count, share: count / total });
  }
  return segments;
}

/**
 * The one sentence that makes a derived state legible.
 *
 * A project card reading only `in_progress` throws away the thing that
 * makes a derived state worth deriving. This composes the three facts the
 * server sends back into the sentence a reader would otherwise have to
 * assemble from three separate places on the page:
 *
 *   *"Waiting — 9 children: 1 blocked, 5 merged, 3 executing. Blocked
 *   because 'Wire the webhook' is blocked."*
 *
 * Returns a plain string rather than JSX so it is assertable directly, and
 * so a caller can put it in a `title` or an `aria-label` as easily as on
 * the page.
 */
export function explainDerivedState(derived: DerivedStateReading, total: number): string {
  const label = COLUMN_LABELS[derived.column];
  if (total <= 0) {
    // Not "Backlog, 0 children" — the column is a derivation over an empty
    // set, so naming it as though it described work would be the same lie
    // as a progress bar at zero percent.
    return `${label} — but there is nothing under this project, so this reading is derived from no work at all.`;
  }
  const parts = distributionOf(derived.counts, total).map(
    (segment) => `${segment.count} ${STATE_LABELS[segment.state].toLowerCase()}`,
  );
  const spread = `${total} ${total === 1 ? "child" : "children"}: ${parts.join(", ")}`;
  const cause = derived.causingChild;
  if (cause === null) return `${label} — ${spread}.`;
  return `${label} — ${spread}. ${label} because "${cause.title}" is ${humanState(cause.state)}.`;
}

/** A state value as a reader says it — falls back to the raw value for a state this build has never seen. */
export function humanState(state: string): string {
  const known = (STATE_LABELS as Record<string, string | undefined>)[state];
  return (known ?? state).toLowerCase();
}

/**
 * What a progress reading should say.
 *
 * Three cases, not two: `empty` is **not** zero percent. A bar drawn at 0%
 * over a project with no children states that work exists and none is done,
 * both halves of which are false. `none` is kept distinct so a malformed
 * response never masquerades as a data condition the product has an opinion
 * about.
 */
export type ProgressReading =
  | { readonly kind: "ratio"; readonly value: number; readonly percent: number }
  | { readonly kind: "empty" }
  | { readonly kind: "none" };

export function progressOf(detail: ProjectDetail): ProgressReading {
  if (detail.childless || detail.total <= 0) return { kind: "empty" };
  if (!Number.isFinite(detail.total) || !Number.isFinite(detail.merged)) return { kind: "none" };
  const value = detail.progress ?? detail.merged / detail.total;
  if (!Number.isFinite(value)) return { kind: "none" };
  // Clamped, so a server that ever reported more merged children than total
  // cannot paint a bar wider than its track.
  const clamped = Math.min(1, Math.max(0, value));
  return { kind: "ratio", value: clamped, percent: Math.round(clamped * 100) };
}

/**
 * How many live crew are on this project or anywhere in the children it
 * returned.
 *
 * Counts `running` and `stalled` and excludes `dead` and `superseded`, the
 * same split the grid makes: the first two are sessions that may still act,
 * and a `superseded` row is the *expected* leftover of a takeover, so
 * counting it would report every handover as two agents on one item.
 *
 * De-duplicated by holder, because one agent holding both a project and a
 * child under it is one agent — counting the rows would report two.
 */
export function liveCrewOn(detail: ProjectDetail): number {
  const holders = new Set<string>();
  const consider = (assignments: readonly { liveness: string; holderId: string }[]) => {
    for (const assignment of assignments) {
      if (assignment.liveness === "running" || assignment.liveness === "stalled") {
        holders.add(assignment.holderId);
      }
    }
  };
  consider(detail.assignments);
  for (const child of detail.children) consider(child.assignments);
  return holders.size;
}

/**
 * The children a reader should be shown first: blocked, then being worked,
 * then everything else — and **childless nested projects last**, the same
 * ordering rule the grid applies to its cards, for the same reason. They
 * are rows nobody can act on until someone repairs them, so they should not
 * lead the list; removing them is how a list stops matching reality.
 *
 * Sorted on a copy — a sort in place would mutate the caller's array, which
 * for a React prop is a value that may be rendered again.
 */
const CHILD_COLUMN_RANK: Readonly<Record<BoardColumnId, number>> = {
  waiting: 0,
  in_progress: 1,
  backlog: 2,
  completed: 3,
};

export function sortChildren(children: readonly ProjectChild[]): ProjectChild[] {
  return [...children].sort((a, b) => {
    if (a.childless !== b.childless) return a.childless ? 1 : -1;
    const column = CHILD_COLUMN_RANK[a.column] - CHILD_COLUMN_RANK[b.column];
    if (column !== 0) return column;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}

/** A short "how long ago" label. Takes `now` so a test can assert every boundary without freezing time globally. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** How a blocked descendant reads when nobody recorded a reason. */
export function blockedReasonText(blocked: BlockedDescendant): string {
  const reason = blocked.blockedReason;
  if (reason !== null && reason.trim() !== "") return reason;
  // Not an empty string and not "Blocked": a reader has to be able to tell
  // "blocked, and here is why" from "blocked, and nobody said why", because
  // only the second is something they can go and fix.
  return "No reason recorded.";
}

// ── The repair offer, and the wall behind it ────────────────────────────
//
// This is the part of the page most able to mislead, so it is the part with
// the most reasoning attached.
//
// A childless project is structurally stuck: a project's state derives from
// its children, so with none there is nothing to transition and no child
// whose completion resolves it. `retype_to_task` turns it into a task under
// a project, which gives it a state of its own — and at that point it *is*
// workable.
//
// **What it is not is closeable.** Reaching `merged` needs a commit
// artifact and an approving code review at the current review round and tip
// commit. For an item whose work shipped long ago there is no reviewer who
// could honestly write one. The product's answer is a
// `historical_verification` artifact — an inspection of already-merged code,
// recorded permanently as an inspection rather than as a review — and the
// merge gate accepts it **only while a deployment-level window is open**.
//
// So there are two genuinely different outcomes, and which one applies is
// not something the client can work out:
//
//   - Window open → repair, then record a verification, then close.
//   - Window shut → repair makes the item workable and **it still cannot be
//     closed**. That is worth doing for live work and is a dead end for work
//     that is already finished.
//
// Offering the repair without that distinction is precisely the failure the
// task names: promising in the UI what the state machine will then refuse.

/** What the page should say about repairing this project, and how strongly. */
export interface RepairOffer {
  /** Whether a repair applies at all — false for a project that has children. */
  readonly applicable: boolean;
  /** What repairing achieves, stated without overclaiming. */
  readonly achieves: string;
  /**
   * The limit, when there is one — the sentence that has to be read before
   * the user commits. Null only when the verification window is open, which
   * is the one case where a repair leads all the way to a closed item.
   */
  readonly limit: string | null;
  /** True when a repaired item still cannot be closed — what a UI keys a warning tone off. */
  readonly deadEndsForFinishedWork: boolean;
}

export function repairOfferFor(repair: RepairAdvice): RepairOffer {
  if (!repair.childless) {
    return {
      applicable: false,
      achieves: "This project has work under it — its state derives from its children as intended.",
      limit: null,
      deadEndsForFinishedWork: false,
    };
  }
  const achieves =
    "Retyping this to a task under a project gives it a state of its own, so it can be transitioned. " +
    "Reparenting moves it under a different project without changing what it is. " +
    "Neither invents a state: whatever is on the row now is kept.";
  if (repair.historicalVerificationAvailable) {
    return {
      applicable: true,
      achieves,
      limit:
        "Closing it still needs evidence: a recorded commit, and either an approving code review or — " +
        "for work that shipped before this installation existed — a historical_verification naming the " +
        "commit it was checked against and what was inspected.",
      deadEndsForFinishedWork: false,
    };
  }
  return {
    applicable: true,
    achieves,
    // The honest version, and deliberately blunt. A user who repairs a
    // shipped item expecting to close it and cannot is worse off than one
    // who was told first: they have changed live data for nothing and have
    // to work out why the refusal happened.
    limit:
      "Repair makes this item transitionable — it does NOT make it closeable. Merging still requires a " +
      "recorded commit and an approving code review at the current tip. If this item's work already " +
      "shipped, there is no reviewer who can honestly approve it, and the alternative (a " +
      "historical_verification artifact) is not enabled on this deployment — so it will be repaired but " +
      "still cannot be closed. Repair it to make it workable; do not repair it expecting to close it.",
    deadEndsForFinishedWork: true,
  };
}
