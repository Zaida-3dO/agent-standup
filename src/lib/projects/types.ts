// The shape the projects grid renders — MILESTONES.md #74, over the
// `GET /api/projects` response `get_projects` produces.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` mirrors `GET /api/board` by hand:
// the front end reaches the service layer only through the adapter's JSON,
// never its modules. Importing the operation's output type here would
// couple every component to how that operation happens to be typed and —
// worse — put a module that transitively imports the database client's
// types onto the client bundle's import graph, which is exactly what
// `npm run check:db-imports` exists to prevent by accident.
//
// Only the fields the grid actually renders are modelled; extra keys the
// response carries are ignored rather than fought with.
import type { BoardAssignment, ItemState } from "@/lib/board/types";

export type { BoardAssignment, ItemState };

/**
 * Counts of a project's descendants by state.
 *
 * A `Record` over the whole vocabulary rather than a sparse map, because
 * the distribution strip is built by walking the states in order: a missing
 * key would render as a gap that looks like a fault rather than as a zero.
 * `Partial` on the way in — a response from an older server missing a state
 * should render that state as empty, not crash the grid.
 */
export type StateCounts = Readonly<Record<ItemState, number>>;

/** One project card's data, as `GET /api/projects` returns it. */
export interface ProjectRollup {
  readonly id: string;
  readonly title: string;
  /** The one-line BLUF, or null when nobody has written one — rendered as nothing, not as an empty line. */
  readonly headline: string | null;
  readonly area: string;
  readonly repo: string | null;
  readonly priority: string;
  /** Every descendant, however deep. */
  readonly total: number;
  /** Descendants in `merged` — the numerator the progress bar shows. */
  readonly merged: number;
  /** Descendants in any terminal state — work that is over, however it ended. */
  readonly finished: number;
  readonly counts: StateCounts;
  /**
   * Merged over total, `0`–`1`, or **null when the project has no children
   * at all**.
   *
   * The null is the whole honesty requirement: zero of zero children merged
   * is not zero percent progress, and a bar rendered at 0% against an empty
   * project asserts that work exists and none of it is done. A renderer has
   * to handle the absent case explicitly, which is the point of it being
   * absent rather than a plausible number.
   */
  readonly progress: number | null;
  /** True when the project has no descendants of any kind — structurally suspect. */
  readonly childless: boolean;
  /** ISO 8601 — the newest `updatedAt` across the project and its subtree. */
  readonly lastActivity: string;
  /** Who holds it now. Empty means nobody, and the key is always present. */
  readonly assignments: readonly BoardAssignment[];
}

/** The whole payload. */
export interface ProjectsPayload {
  readonly projects: readonly ProjectRollup[];
  /** How many of `projects` are childless — surfaced without the client re-counting. */
  readonly childlessCount: number;
}
