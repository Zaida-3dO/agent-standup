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

/** The newest recorded check of this item's `state` — MILESTONES.md #131. */
export interface DetailVerification {
  readonly checkedAt: string;
  readonly checkedByType: string;
  /**
   * *Which* holder ran the check, where the artifact recorded one.
   *
   * Null is an ordinary case rather than a defect — an artifact can be
   * written with a type but no id — so a reader must render its absence as
   * "a person" rather than as a missing name.
   */
  readonly checkedById: string | null;
  readonly body: string | null;
  readonly commitSha: string | null;
}

/**
 * The item's own `historical_verification` kind name, mirrored so this
 * module needs no import from the server's artifact-kind vocabulary — the
 * client never imports service-layer modules (`board/types.ts`'s header
 * gives the full reason).
 */
const HISTORICAL_VERIFICATION_KIND = "historical_verification";

/**
 * The newest `historical_verification` artifact against this item, or
 * `null` when nobody has recorded one.
 *
 * The detail response already carries every artifact (`get_item_detail`
 * reads the whole table once, ordered `reviewRound ASC, createdAt ASC`), so
 * this needs no extra call — it is the same "derive from what the server
 * already sent" discipline `latestVerdict` follows next to it, applied to a
 * different kind. Server order is round-then-creation, which is not
 * creation order alone, so this scans for the maximum `createdAt` rather
 * than trusting the last matching entry — a `historical_verification` never
 * carries a review round that means anything (it isn't a review), but nothing
 * stops a caller passing one, and reading the array positionally would then
 * silently pick the wrong one.
 */
export function newestVerification(
  artifacts: readonly DetailArtifact[],
): DetailVerification | null {
  let best: DetailArtifact | null = null;
  for (const artifact of artifacts) {
    if (artifact.kind !== HISTORICAL_VERIFICATION_KIND) continue;
    if (best === null || artifact.createdAt >= best.createdAt) best = artifact;
  }
  if (best === null) return null;
  return {
    checkedAt: best.createdAt,
    checkedByType: best.createdByType,
    checkedById: best.createdById,
    body: best.body,
    commitSha: best.commitSha,
  };
}

/**
 * Whether this item's `state` was ever written by this product's own state
 * machine, or arrived by copy from an external store — the mechanical
 * signal `trust-view.ts` (server side) uses for the same question, mirrored
 * here so the client can decide without a round trip. See that module's
 * header for why `originType` and not `headline`-vs-`state` is the check.
 */
export function isUnverifiedOrigin(originType: string): boolean {
  return originType === "source";
}

/**
 * The item's current tip commit, derived from its own artifacts — mirrors
 * `currentTipCommitSha` (`src/lib/service/guards/artifact-tip.ts`) client
 * side, off the same data: the newest `commit`-kind artifact's `commitSha`,
 * or `null` when the item has none.
 *
 * The detail response already carries every artifact, so this needs no
 * extra call — same "derive from what the server already sent" discipline
 * `newestVerification` follows next to it. `record_artifact` refuses a
 * `historical_verification` with no `commitSha`, so the "confirm state"
 * action reads this to know whether the button can be offered at all,
 * rather than letting the click fail on the server after the fact.
 */
export function currentTipCommitSha(artifacts: readonly DetailArtifact[]): string | null {
  let best: DetailArtifact | null = null;
  for (const artifact of artifacts) {
    if (artifact.kind !== "commit") continue;
    if (artifact.commitSha === null) continue;
    if (best === null || artifact.createdAt >= best.createdAt) best = artifact;
  }
  return best?.commitSha ?? null;
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
    assignments: [],
    previousHolders: [],
  };
}

/**
 * The artifact kinds each of the two artifact-backed tabs shows.
 *
 * The Plan tab answers *"what was this work going to be, and was that
 * agreed"*, which is the plan and the review OF the plan — a plan review is
 * on the plan's side of the conversation, not the code's, and filing it
 * under Reviews would separate an approval from the thing it approved.
 *
 * The Reviews tab answers *"what did someone find in the work"*: the
 * reviews of the code and of what it looks like, and the verification of
 * work checked after it shipped. `test_run` sits here too — it is evidence
 * about the change, produced by the same round, and it is read alongside
 * the review that cites it.
 *
 * **Kinds appear on at most one of the two.** An artifact shown under both
 * would be counted twice by the tab counts, and a reader who saw it on Plan
 * would have no way to tell whether the copy under Reviews was the same row
 * or a second one.
 */
const PLAN_KINDS: ReadonlySet<string> = new Set(["plan", "plan_review"]);

const REVIEW_KINDS: ReadonlySet<string> = new Set([
  "code_review",
  "visual_review",
  "historical_verification",
  "test_run",
]);

/**
 * The tab an artifact belongs to, or `null` for one that belongs to
 * neither.
 *
 * `commit`, `screenshot` and `other` are deliberately `null` rather than
 * being swept into Reviews. A commit is the work itself and a screenshot is
 * an attachment; neither is a finding, and putting them under a heading
 * that means "someone assessed this" would let an unreviewed item look
 * reviewed — which is the one misreading this page must not produce.
 *
 * An unrecognised kind is also `null`, for the same reason `PASSING_VERDICTS`
 * treats an unknown verdict as not-yet-cleared: a kind this code has never
 * seen makes no claim it is safe to assume, and the failure mode of hiding
 * it from a tab is milder than the failure mode of filing it under a
 * heading it may contradict.
 */
export function artifactTab(kind: string): "plan" | "reviews" | null {
  if (PLAN_KINDS.has(kind)) return "plan";
  if (REVIEW_KINDS.has(kind)) return "reviews";
  return null;
}

/** The artifacts belonging to one of the two artifact-backed tabs, in the order given. */
export function artifactsForTab(
  artifacts: readonly DetailArtifact[],
  tab: "plan" | "reviews",
): readonly DetailArtifact[] {
  return artifacts.filter((artifact) => artifactTab(artifact.kind) === tab);
}
