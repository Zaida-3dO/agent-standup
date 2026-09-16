// The projects grid's pure logic — every decision a card makes about what
// to show, as plain functions over plain data.
//
// Split out from the components for the reason the whole front end here is:
// the harness runs `environment: "node"` with no DOM, so logic living
// inside a component is only reachable by rendering it, while logic living
// here is callable directly. These are the functions that decide whether a
// project reads as honest or as a lie, so they are the ones that need to be
// directly assertable.
import { ITEM_STATES } from "@/lib/design/tokens";
import type { ItemState } from "@/lib/board/types";
import type { ProjectRollup, StateCounts } from "./types";

/**
 * What a progress bar should say about a project.
 *
 * Three cases, not two, and the third is the reason this is a function
 * rather than a percentage inline in JSX:
 *
 *   - `ratio` — real work, some fraction of it finished.
 *   - `empty` — **no children at all.** Not zero percent: there is nothing
 *     to be a fraction of. A bar drawn at 0% here states that work exists
 *     and none is done, which is false, and it is indistinguishable from a
 *     project that has ten children and has finished none.
 *   - `none` — a malformed response (a negative or non-finite total). Kept
 *     distinct from `empty` so a rendering bug never masquerades as a data
 *     condition the product has an opinion about.
 */
export type ProgressReading =
  | { readonly kind: "ratio"; readonly value: number; readonly percent: number }
  | { readonly kind: "empty" }
  | { readonly kind: "none" };

/**
 * Reads a project's progress.
 *
 * Trusts `childless` over arithmetic on `total`, because the server owns
 * that judgement and the two agreeing is the server's invariant to keep —
 * but falls back to `total <= 0` so a response missing the field still
 * cannot produce a 0% bar over no work.
 */
export function progressOf(project: ProjectRollup): ProgressReading {
  if (project.childless || project.total <= 0) return { kind: "empty" };
  if (!Number.isFinite(project.total) || !Number.isFinite(project.finished))
    return { kind: "none" };
  const value = project.progress ?? project.finished / project.total;
  if (!Number.isFinite(value)) return { kind: "none" };
  // Clamped, so a server that ever reported more finished children than
  // total cannot paint a bar wider than its track.
  const clamped = Math.min(1, Math.max(0, value));
  return { kind: "ratio", value: clamped, percent: Math.round(clamped * 100) };
}

/** One band of the distribution strip — a state with at least one child in it. */
export interface DistributionSegment {
  readonly state: ItemState;
  readonly count: number;
  /** Share of the project's children, `0`–`1`. What the band's width is drawn from. */
  readonly share: number;
}

/**
 * The distribution strip: every state a project actually has children in,
 * in the vocabulary's own order.
 *
 * **Empty states are omitted, not rendered at zero width.** A zero-width
 * band is invisible but still a DOM node with a border, and twelve of them
 * per card is eleven hairlines of noise on a card that usually has children
 * in two or three states.
 *
 * The order is `ITEM_STATES` rather than descending by count, so the strip
 * reads left-to-right as a lifecycle — backlog through to done — and the
 * same project does not reshuffle its bands as work moves between two
 * states of similar size.
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
 * The three bands of the progress bar, as shares of `0`–`1`.
 *
 * **One bar, three bands.** A card draws the subtree once, at one
 * denominator: two bars over the same children invite a reader to compare
 * them, and a fill that counts only what shipped reads as "20% left to do"
 * on a project with nothing left to do.
 *
 *   - `finished` — every terminal state. Work that is over, however it ended:
 *     a scope cut is a way of finishing, not a debt.
 *   - `active` — claimed or queued: `on_deck` plus everything in progress or
 *     waiting. Work that is going to happen.
 *   - the remainder — `someday`, drawn as empty track. Genuinely unscheduled.
 *
 * `on_deck` sits in `active` rather than with the backlog even though
 * `board/columns.ts` files it under `backlog`, because the two are answering
 * different questions: the board asks which column to draw a card in, and
 * this asks whether a reader should count the work as spoken for. Something
 * on deck is spoken for; something in `someday` is not.
 *
 * Shares are computed from the same `total` so the three always sum to ≤ 1.
 */
export interface ProgressBands {
  readonly finished: number;
  readonly active: number;
}

/** States drawn in the `active` band — see `ProgressBands`. */
const ACTIVE_STATES: readonly ItemState[] = [
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
  "paused",
  "blocked",
];

/** States drawn in the `finished` band — the terminal four. */
const FINISHED_STATES: readonly ItemState[] = ["merged", "research_done", "wont_do", "cancelled"];

export function bandsOf(counts: StateCounts, total: number): ProgressBands {
  if (total <= 0) return { finished: 0, active: 0 };
  const sum = (states: readonly ItemState[]) =>
    states.reduce((acc, state) => acc + (counts[state] ?? 0), 0);
  return { finished: sum(FINISHED_STATES) / total, active: sum(ACTIVE_STATES) / total };
}

/**
 * The card's legend: the same three bands as counts.
 *
 * **Three numbers, not twelve.** Spelling out every state a project has
 * children in (`On deck 1 · Merged 36 · Research done 3 · Won't do 5`) asks a
 * reader to redo the arithmetic the bar has already done, and to know that
 * "Won't do" is a way of being finished. These are the bands the bar draws,
 * named as a reader thinks of them.
 *
 * `done` is also the "X of Y closed" numerator, read from the same place as
 * `progressOf`'s so the count and the percentage cannot disagree.
 */
export interface ProgressCounts {
  readonly onDeck: number;
  readonly done: number;
  readonly notStarted: number;
}

export function countsOf(counts: StateCounts, total: number): ProgressCounts {
  const sum = (states: readonly ItemState[]) =>
    states.reduce((acc, state) => acc + (counts[state] ?? 0), 0);
  const onDeck = sum(ACTIVE_STATES);
  const done = sum(FINISHED_STATES);
  // The remainder rather than `someday` alone, so a state added to the
  // vocabulary and forgotten here still lands somewhere and the three
  // numbers always account for every child.
  return { onDeck, done, notStarted: Math.max(0, total - onDeck - done) };
}

/**
 * How many live crew are on a project.
 *
 * Counts `running` and `stalled` and excludes `dead` and `superseded`: the
 * first two are sessions that may still act, and the last two emphatically
 * are not — a `superseded` row is the *expected* leftover of a takeover, so
 * counting it would report every handover as two agents on one project.
 */
export function liveCrewCount(project: ProjectRollup): number {
  return project.assignments.filter(
    (assignment) => assignment.liveness === "running" || assignment.liveness === "stalled",
  ).length;
}

/**
 * A short "how long ago" label — the card's last-activity line.
 *
 * Takes `now` as an argument rather than reading the clock, so a test can
 * assert every boundary without freezing time globally. Returns a fixed
 * string for an unparseable date rather than `Invalid Date`, which is what
 * a naive implementation renders straight onto the card.
 */
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

/**
 * Orders the grid: projects with live crew first, then the ones being
 * worked, then everything else by recency — and **childless projects last**.
 *
 * Childless last rather than hidden. They are the rows a reader can do
 * nothing useful with until someone repairs them, so they should not lead
 * the page; but removing them is how a board stops matching reality, and
 * the count in the header would then disagree with what is under it.
 *
 * Sorted on a copy — a sort in place would mutate the caller's array, which
 * for a React prop is a value that may be rendered again.
 */
export function sortProjects(projects: readonly ProjectRollup[]): ProjectRollup[] {
  return [...projects].sort((a, b) => {
    if (a.childless !== b.childless) return a.childless ? 1 : -1;
    const crew = liveCrewCount(b) - liveCrewCount(a);
    if (crew !== 0) return crew;
    // ISO 8601 sorts lexicographically in the same order it sorts
    // chronologically, so no `Date` allocation is needed per comparison.
    if (a.lastActivity !== b.lastActivity) return a.lastActivity < b.lastActivity ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}
