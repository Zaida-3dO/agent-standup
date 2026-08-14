// The item-detail view's display derivations — MILESTONES.md #72.
//
// Every decision about how the detail view *looks* lives here, as plain
// functions over plain data, so this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`) can exercise it directly
// rather than only through a rendered component — the same split
// `src/lib/board/view.ts` follows. The components under
// `src/components/item-detail/` are the thin presentational layer over
// these.
//
// **This module derives nothing the server already derived.** Which column
// an item or a subtask sits in is the server's answer, because a project's
// column is a recursive walk over a subtree the client does not have. The
// client reads `detail.column` and `subtask.column` and never recomputes
// them — the convention #37's review established.
import type {
  DetailArtifact,
  DetailHistoryEntry,
  DetailSubtask,
  DetailSummary,
  ItemDetail,
} from "./types";

/**
 * How a state reads on screen — `plan_review` as "plan review". The stored
 * vocabulary is snake_case (SCHEMA.md §1.1) and every surface that shows it
 * to a person makes the same substitution, so it is one function rather
 * than a regex repeated per component.
 */
export function humanState(state: string): string {
  return state.replace(/_/g, " ");
}

/**
 * Whether an item's own `state` is meaningful enough to show.
 *
 * **False for a project**, whose stored state is a creation leftover rather
 * than a fact about it (DECISIONS.md §13c: "a project can't be parked
 * independently of its children"). Showing it would be actively misleading
 * on the one screen most likely to be read as authoritative — a project
 * created `on_deck` and long since finished still carries `on_deck` in its
 * row. The detail view shows the derived column instead, which is true.
 */
export function showsOwnState(kind: string): boolean {
  return kind !== "project";
}

/**
 * The one-line reason an item gives for being in Waiting. Paused and
 * blocked carry different fields (SCHEMA.md §1.1); anything else has no
 * reason to give, which is `null` rather than an empty string so a
 * component renders nothing instead of an empty line.
 */
export function waitingReason(item: {
  readonly state: string;
  readonly pauseReason: string | null;
  readonly blockedReason: string | null;
}): string | null {
  if (item.state === "paused") return item.pauseReason;
  if (item.state === "blocked") return item.blockedReason;
  return null;
}

/**
 * The subtask tree's progress: how many descendants are finished, out of
 * how many countable ones.
 *
 * **Projects are excluded from both halves.** A project is structure, not
 * work — it has no state of its own to be finished (DECISIONS.md §13c), so
 * counting it as an incomplete denominator would make a fully-merged tree
 * read as unfinished purely because it is organised into sub-projects.
 * Counting it as complete would be worse. It is simply not a unit of
 * progress.
 */
export interface SubtaskProgress {
  readonly done: number;
  readonly total: number;
}

/** The states that mean a subtask is finished — the `completed` column's states (SCHEMA.md §1.1). */
const DONE_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

export function subtaskProgress(subtasks: readonly DetailSubtask[]): SubtaskProgress {
  let done = 0;
  let total = 0;
  for (const subtask of subtasks) {
    if (subtask.kind === "project") continue;
    total++;
    if (DONE_STATES.has(subtask.state)) done++;
  }
  return { done, total };
}

/**
 * Artifacts grouped by review round, rounds ascending — how a review
 * history is actually read ("what did round 2 say"), rather than as one
 * flat list where a round-1 finding sits next to a round-3 verdict with
 * nothing marking the boundary.
 *
 * Artifacts with no review round of their own still land in a round —
 * `reviewRound` defaults to 1 in the schema, so there is no null case to
 * handle here.
 */
export interface ArtifactRound {
  readonly round: number;
  readonly artifacts: readonly DetailArtifact[];
}

export function artifactsByRound(artifacts: readonly DetailArtifact[]): ArtifactRound[] {
  const byRound = new Map<number, DetailArtifact[]>();
  for (const artifact of artifacts) {
    const list = byRound.get(artifact.reviewRound) ?? [];
    list.push(artifact);
    byRound.set(artifact.reviewRound, list);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, list]) => ({ round, artifacts: list }));
}

/**
 * The verdict that decides the item's review standing — the **latest**
 * round's, not the first or the most favourable.
 *
 * Reading the newest is the only honest answer: a round-1 `lgtm` followed
 * by a round-2 `changes_requested` means changes are requested, and any
 * rule that surfaced the earlier one would report a stale pass on work that
 * has since been sent back. Rounds tie-break by position, so the last
 * artifact recorded in the highest round wins — the server already orders
 * by round then creation time.
 */
export function latestVerdict(artifacts: readonly DetailArtifact[]): string | null {
  let best: DetailArtifact | null = null;
  for (const artifact of artifacts) {
    if (artifact.verdict === null) continue;
    if (best === null || artifact.reviewRound >= best.reviewRound) best = artifact;
  }
  return best?.verdict ?? null;
}

/**
 * How a history entry's type reads on screen. Same substitution as
 * `humanState` and deliberately a separate function: the two vocabularies
 * are unrelated (`EventType` vs `ItemState`), and two independent things
 * happening to need the same formatting is not a reason to couple them —
 * either is free to change its display without dragging the other with it.
 */
export function humanEventType(type: string): string {
  return type.replace(/_/g, " ");
}

/**
 * History newest-first, as the server sent it. This is an identity on
 * order — stated as a function so the *intent* is asserted somewhere: a
 * later change to the query's ordering breaks a test here rather than
 * silently flipping the view into oldest-first.
 */
export function orderedHistory(
  history: readonly DetailHistoryEntry[],
): readonly DetailHistoryEntry[] {
  return [...history].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
}

/**
 * Whether the summary section has anything to show. A summary exists only
 * once an item has been completed (SCHEMA.md §5a), so an in-progress item
 * shows no section at all rather than an empty one headed "Summary".
 */
export function hasSummary(summary: DetailSummary | null): summary is DetailSummary {
  return summary !== null;
}

/**
 * The entries of `shipped` / `not_done` / `what_to_test` / `watch_for`, as
 * a list of strings the view can render.
 *
 * These are `Json` columns validated in code rather than by the column
 * (SCHEMA.md §5a), so what actually arrives is `unknown` and a detail view
 * that assumed `string[]` would crash on a legitimately-shaped-differently
 * row. Anything that is not an array becomes an empty list, and non-string
 * entries are rendered by their `text` field when they have one (the
 * `not_done` shape) or stringified — the view degrades rather than throws,
 * because a malformed stored summary should not take out the screen that
 * would let anybody see it.
 */
export function summaryEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry !== null && typeof entry === "object") {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return JSON.stringify(entry) ?? "";
  });
}

/** An empty detail — the initial render state, and a base for tests. */
export function emptyDetailFor(item: ItemDetail["item"]): ItemDetail {
  return {
    item,
    column: "backlog",
    subtasks: [],
    artifacts: [],
    history: [],
    historyTruncated: false,
    summary: null,
  };
}
