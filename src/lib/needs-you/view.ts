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

/** The reason label a row shows — one of the four the task names, never collapsed into "waiting". */
export const REASON_LABELS: Readonly<Record<NeedsYouReason, string>> = {
  blocked_on_you: "Blocked on you",
  needs_approval: "Needs your approval to merge",
  needs_visual_review: "Needs you to look at it",
  plan_review: "Plan awaiting approval",
};

/**
 * The one line under the label saying what the person is actually being
 * asked for. The labels above say *why the row is here*; these say *what
 * clicking will do*, which is the distinction the four controls rest on —
 * and in particular the difference between authorising a merge and
 * reviewing code, which are separate acts recorded as separate rows.
 */
export const REASON_PROMPTS: Readonly<Record<NeedsYouReason, string>> = {
  blocked_on_you: "Someone is waiting on an answer from you.",
  needs_approval:
    "Your decision to let this merge — recorded against the commit below, not a code review.",
  needs_visual_review: "Someone needs you to look at this and say whether it looks right.",
  plan_review: "Approving this releases the work to start.",
};

/**
 * The verb pair a decision row's two buttons carry.
 *
 * Per-reason rather than a shared "Approve"/"Deny", because the acts are
 * genuinely different and the button is the last thing a person reads
 * before committing to one. "Approve merge" is an authorisation; "Looks
 * right" is an observation. A single "Approve" across both would be the
 * label-level version of the collapse `respond.ts` exists to prevent.
 *
 * `reject: null` means the reason has no rejecting control — see
 * `reject()`'s doc for why `needs_approval` is given or withheld rather
 * than refused on the record.
 */
export const DECISION_LABELS: Readonly<
  Record<string, { readonly approve: string; readonly reject: string | null }>
> = {
  needs_approval: { approve: "Approve merge", reject: null },
  needs_visual_review: { approve: "Looks right", reject: "Needs changes" },
  plan_review: { approve: "Approve plan", reject: "Request changes" },
};

/**
 * Whether this row's decision control can actually be offered.
 *
 * `needs_approval` and `needs_visual_review` both record an artifact pinned
 * to the item's tip commit, and `record_artifact` refuses one with no
 * `commitSha`. An item with no commit recorded therefore has nothing a
 * decision could apply to — so the button is disabled with an explanation
 * rather than offered and failing on click, the same discipline the
 * "confirm state" action already follows.
 */
export function canDecide(item: NeedsYouItem): boolean {
  if (item.reason === "needs_approval" || item.reason === "needs_visual_review") {
    return item.tipCommitSha !== null;
  }
  return true;
}

/**
 * Whether this row's links should point at the item's Reviews tab rather
 * than the item itself.
 *
 * True for the reasons whose wait is answered by a review artifact, which
 * is where the findings behind the decision are. A `blocked_on_you` row has
 * no review artifact to point at, so it links to the item.
 *
 * Exported and shared by both callers — `NeedsYouRow` and the digest's
 * `NeedsYouBlock` — so the same item links to the same place whether a
 * reader reaches it from the preview on `/` or from the full inbox.
 *
 * Deliberately its own rule rather than a reuse of `canDecide`: "where does
 * this link" and "can this be decided" are different questions, and a row
 * can be undecidable for want of a commit while still having findings worth
 * reading.
 */
export function linksToReviews(item: NeedsYouItem): boolean {
  return item.reason !== "blocked_on_you";
}

/** The short sha a decision names, for the row to show what is being approved. */
export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, 7);
}
