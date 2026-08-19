// `/needs-you`'s pure display logic — ordering and the waiting-age label,
// as plain functions over plain data. Split out for the reason the whole
// front end here is: this repo's harness runs `environment: "node"` with
// no DOM, so these are only directly testable outside a component.
import type { NeedsYouItem, NeedsYouReason } from "./types";
import { relativeTime } from "@/lib/projects/view";

/**
 * Oldest first — the task's own ordering. `updatedAt` is what an item's
 * inbox admission is measured from: a `blocked` item is admitted the
 * instant it is marked blocked (which touches the row), a `plan_review` or
 * `in_review` item the instant it entered that state (a state transition is
 * also a row touch) — so `updatedAt` is, in every one of the three cases,
 * the moment this item started waiting on a person, not some unrelated
 * later edit.
 *
 * Sorted on a copy, matching `sortProjects` — a sort in place would mutate
 * a value held in React state.
 */
export function sortByWaiting(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * How long an item has been waiting, as a short label — "3h", "2d" — the
 * SLA feel the task's brief asks for: age visible rather than inferred.
 *
 * Built on the same `relativeTime` the projects grid already uses for "last
 * activity", stripped of its trailing "ago" — this label sits next to a
 * reason ("blocked on you") where "3h ago" reads as a stale timestamp and
 * "waiting 3h" reads as the fact it is.
 */
export function waitingFor(item: NeedsYouItem, now: number): string {
  return relativeTime(item.updatedAt, now).replace(/ ago$/, "");
}

/** The reason label a row shows — one of the three the task names, never collapsed into "waiting". */
export const REASON_LABELS: Readonly<Record<NeedsYouReason, string>> = {
  blocked_on_you: "Blocked on you",
  needs_approval: "Needs your approval",
  plan_review: "Plan awaiting approval",
};

/**
 * Whether this reason is something `/needs-you` can act on in place, as
 * "approve" or "deny" — the task's own words for the decide-in-place
 * action, over the existing `record_artifact` + `transition_item`
 * operations.
 *
 * **`plan_review` and `needs_approval` are decidable; `blocked_on_you` is
 * not**, and that split is deliberate rather than a gap. The former two each
 * have exactly one well-defined transition a person's approval unlocks —
 * `plan_review → executing` on an approved `plan_review` artifact
 * (`../service/guards/plan-approval.ts`), `in_review → merged` on an
 * approving `code_review` recorded by a person
 * (`../service/guards/merge.ts`'s `needs_approval` clause) — which is what
 * "approve" and "deny" cleanly mean. A `blocked` item has no single
 * canonical unblock target (`../service/state-machine/transition.ts`
 * permits many `from: "blocked"` transitions, chosen by what actually
 * unblocks that specific item), so inventing an "approve" button for it
 * would be a guess at a transition this screen has no way to know is right.
 * Its row still links to the item, where a person can act with full
 * context.
 */
export function isDecidable(item: NeedsYouItem): boolean {
  return item.reason === "plan_review" || item.reason === "needs_approval";
}
