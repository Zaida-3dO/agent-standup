// `get_projects` — every project with the rolled-up state of its subtree.
// MILESTONES.md #74 ("Project view and progress view").
//
// ── The question this answers, and why no existing read answers it ──────
//
// A project is the only level at which *progress* is a meaningful number.
// "Three of nine children merged" is a real completion ratio; the same
// sentence about a single task is a category error, because a task is one
// unit of work that is either done or not. So the grid this feeds is the
// honest grouping for a store whose backlog has grown past what one column
// can show, and the rollup is what makes each card say something.
//
// `get_board` returns items grouped by column and `list_items` returns a
// filtered page of rows. Neither carries a per-project breakdown, and
// neither can be made to without the caller doing the tree walk itself.
//
// ── One query, and why that is the whole design constraint ──────────────
//
// **The rollup is computed in a single recursive statement, not per
// project.** The obvious implementation — read the projects, then for each
// one ask for its children — is N+1 against a page that by construction
// shows *every* project, so its cost grows with exactly the number the
// screen exists to display. On the corpus this was built against that is
// one query against roughly a hundred.
//
// The recursion is the same shape `get_board` already walks for a project's
// derived column: seed with the direct children of every project at once
// (`"parentId" = ANY(...)`), then follow `parentId` down, carrying the
// **root** project id through every level so a grandchild is still counted
// against the project it ultimately belongs to. `kind`'s nesting is
// unbounded (SCHEMA.md §1), so a single-level join would silently undercount
// any project whose work is organised one level deeper.
//
// What this operation adds over that walk is aggregation: the board needs
// only "which column does this project belong in", so it collects states
// into a list and picks the most active. A grid card needs the whole
// distribution, so the counting happens in SQL — `count(*) FILTER (WHERE …)`
// per state — and one row comes back per project rather than one row per
// descendant. That difference matters at size: the board's shape returns a
// row for every task in the store, and this returns a row for every project.
//
// ── Why the counts are by state and not by column ───────────────────────
//
// The card renders a distribution strip, which is the spread *beneath* the
// rollup rather than a summary of it — the thing a single derived column
// throws away. Returning the twelve-value state vocabulary intact and
// letting the client group it into columns keeps that possible; returning
// four column counts would not, and the collapse would be irreversible on
// the client. `columnForState` is exported for a caller that wants the
// coarser view, so nothing is lost by sending the finer one.
//
// ── A childless project is reported as such, never as zero percent ──────
//
// A parentless item with no children at all is a real and common shape: a
// bulk import from a store with no project/task distinction types every
// root it loads as a project, and ordinary tasks arrive in exactly this
// condition (the same shape `repair_stuck_projects` scans for). Such a row
// can be neither transitioned — a project has no state of its own — nor
// resolved by a child completing, so it reads as open permanently.
//
// Two things follow, and both are deliberate:
//
//   - **`childless` is its own field, not an inference from `total === 0`.**
//     A caller can compute that, but the point is that it should not have
//     to *decide* what it means: zero of zero children merged is not zero
//     percent progress, it is a project with no work under it, and a card
//     that renders "0%" against it states something false about work that
//     does not exist. So `progress` is `null` rather than `0` in that case
//     — an absent ratio, which a renderer must handle, instead of a
//     plausible wrong one it would render without noticing.
//   - **They are returned, never filtered out.** Hiding structurally broken
//     rows is how a board stops being trustworthy: the count at the top
//     stops matching what is under it, and the discrepancy is invisible
//     precisely because the evidence was removed. Repairing them is a
//     separate, deliberate operation (`repair_stuck_projects`); this read's
//     job is to make them visible enough that someone runs it.
//
// ── Live crew, in the one statement the board already established ───────
//
// Every project's live assignments are fetched with the slim
// `BoardAssignment` projection, keyed on `itemId = ANY(...)` — one
// statement for the whole page, the same N+1 avoidance `get_board` makes
// for its cards, reusing the same SQL constant so the two reads cannot
// disagree about what "who holds this" means. The count a card shows is
// derived from those rows rather than being a second, separately-queried
// number.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_STATES, type ItemStateValue } from "../state-machine/states";
import { areaFilterCondition } from "../items/area-filter";
import { NOT_ARCHIVED_CONDITION } from "../items/row";
import {
  LIVE_BOARD_ASSIGNMENTS_SQL,
  groupBoardAssignmentsByItem,
  isoOrString,
  isoOrStringOrNull,
  type BoardAssignment,
  type RawBoardAssignmentRow,
} from "../items/assignment-view";

/**
 * Counts of a project's descendants by state — every state present, so a
 * reader never has to distinguish "none in this state" from "this state was
 * not reported".
 *
 * A `Record` over the full vocabulary rather than a sparse map: the strip
 * on a card is built by walking the states in order, and a missing key
 * would render as a gap that looks like a rendering fault rather than as a
 * zero.
 */
export type StateCounts = Readonly<Record<ItemStateValue, number>>;

/** One project, with its subtree rolled up. */
export interface ProjectRollup {
  readonly id: string;
  readonly title: string;
  /** The one-line BLUF (MILESTONES.md #107), or null when nobody has written one. */
  readonly headline: string | null;
  readonly area: string;
  readonly repo: string | null;
  readonly priority: string;
  /** Every descendant, however deep — not just direct children. */
  readonly total: number;
  /** Descendants in `merged` specifically — the numerator a progress bar shows. */
  readonly merged: number;
  /**
   * Descendants in any terminal state (`merged`, `research_done`, `wont_do`,
   * `cancelled`) — work that is over, however it ended.
   *
   * Returned beside `merged` rather than instead of it because they answer
   * different questions: a progress bar measures work that *shipped*, while
   * "is anything still live under here" is what decides whether a project is
   * finished. A project whose remaining children were all cancelled is done,
   * and is not 100% merged.
   */
  readonly finished: number;
  /** The full distribution — see `StateCounts`. */
  readonly counts: StateCounts;
  /**
   * Merged over total, `0`–`1`, or **null when there are no children at
   * all**. Null rather than zero on purpose: see the module header.
   */
  readonly progress: number | null;
  /**
   * True when this project has no descendants of any kind — structurally
   * suspect, because such a row can never reach a resolved state by any
   * route. Its own field rather than something the caller infers; see the
   * module header.
   */
  readonly childless: boolean;
  /**
   * The most recent `updatedAt` across the project and its whole subtree, as
   * ISO 8601.
   *
   * The subtree is included rather than just the project's own row because
   * a project row is only touched when the project itself is edited, which
   * for an active project is almost never — so its own `updatedAt` would
   * report a project whose children were all touched this morning as
   * untouched for months. Never null: it falls back to the project's own
   * timestamp when there are no children.
   */
  readonly lastActivity: string;
  /** Who holds this project right now — live assignments only, in claim order. Empty when nobody does. */
  readonly assignments: readonly BoardAssignment[];
}

export interface GetProjectsOutput {
  readonly projects: readonly ProjectRollup[];
  /** How many of `projects` are childless — the flag a caller surfaces without re-counting. */
  readonly childlessCount: number;
  /** The `id` of the last project in this page, to pass back as `cursor`. Null when this page is the last. */
  readonly nextCursor: string | null;
}

/** The page bound — see `limit` in the input schema. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    /** Restricts to one area. Omitted returns every area. */
    area: z.string().trim().min(1).optional(),
    /** Restricts to one repo. Omitted returns every repo. */
    repo: z.string().trim().min(1).optional(),
    /**
     * Whether to include projects whose every descendant is finished.
     *
     * Defaults to `false` for the reason every other read here bounds
     * itself (MILESTONES.md #103): completed work is the majority of a store
     * that has been used for a while and its share only grows, so the
     * default view is the work in flight. A project with **no** children is
     * never excluded by this — it is not finished, it is broken, and
     * hiding it behind a flag about completion would be the "silently
     * hidden" failure this read exists to avoid.
     */
    includeCompleted: z.boolean().default(false),
    /**
     * Whether to include archived projects, and archived descendants in
     * every rollup number.
     *
     * Defaults to `false`: an archived root is not a card. A grid that
     * shows one contradicts the archive that hid it everywhere else, and
     * the caller who just archived it reads the card as the archive having
     * silently failed.
     *
     * It widens **both** halves of the rollup deliberately. Excluding the
     * root but still counting archived descendants would leave a card whose
     * `total` disagreed with the tree beneath it, and a project whose only
     * remaining child was archived would render as live work — the same
     * class of wrong number, one level down. `list_items` refuses a flag
     * like this for a good reason (an archive is the installation saying a
     * row should never have existed, so a generous filter should not put it
     * back in front of an ordinary caller); it is offered here because a
     * grid is also the natural place to *audit* what was archived, and
     * because the counting half has no other way to be inspected.
     */
    includeArchived: z.boolean().default(false),
    /**
     * The most projects to return — MILESTONES.md #109.
     *
     * This read returns one row per project rather than one per task, so
     * the grid stays small while a store is young. That is a fact about how
     * much data a store happens to hold, not a property of the code, and
     * every project carries a twelve-entry distribution plus its live crew,
     * so the row is not free either.
     *
     * 50 is a full grid; 200 is the most a caller may ask for.
     */
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    /** The `id` of the last project of the previous page — pass back `nextCursor`. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type GetProjectsInput = z.infer<typeof inputSchema>;

/** The raw aggregate row — one per project, counts arriving as `bigint`. */
interface RawProjectRollupRow {
  id: string;
  title: string;
  headline: string | null;
  area: string;
  repo: string | null;
  priority: string;
  updatedAt: Date | string;
  lastChildActivity: Date | string | null;
  total: bigint | number;
  // One count column per state, aliased `count_<state>`.
  [countColumn: string]: unknown;
}

/**
 * Postgres returns `count(*)` as `bigint`, which the driver hands back as a
 * JS `BigInt` — a value `JSON.stringify` throws on rather than serialising.
 * Every count crosses an adapter boundary, so each is narrowed here rather
 * than at the four call sites that would otherwise each have to remember.
 */
function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/**
 * The `count(*) FILTER (WHERE …)` list, one column per state.
 *
 * Built from `ITEM_STATES` rather than written out so a thirteenth state
 * cannot be added to the vocabulary and silently omitted from every card's
 * distribution — the same reasoning `tokens.ts` gives for typing its maps
 * as `Record<ItemState, …>`. The state values are interpolated into SQL,
 * which is safe **only** because they come from this module-level constant
 * and never from input; there is no path from a caller to this string.
 */
const STATE_COUNT_COLUMNS = ITEM_STATES.map(
  (state) =>
    `count(*) FILTER (WHERE d."state" = '${state}'::"ItemState")::bigint AS "count_${state}"`,
).join(",\n           ");

/** Reads one state's count off a raw row, defaulting a state with no descendants to zero. */
function countsFrom(row: RawProjectRollupRow): StateCounts {
  const counts = {} as Record<ItemStateValue, number>;
  for (const state of ITEM_STATES) {
    counts[state] = toNumber(row[`count_${state}`]);
  }
  return counts;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getProjects = defineOperation({
  name: "get_projects",
  kind: "read",
  summary:
    "Lists projects with their subtree rolled up: child counts by state, total, merged and finished counts, progress, last activity and live crew. Computed in one recursive query rather than per project. A project with no children is reported with progress null and childless true, never as zero percent, and is never hidden. Archived projects and archived descendants are excluded from the grid and from every rollup number — pass includeArchived to audit them. Paged: pass limit and cursor, and read nextCursor for the following page.",
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["includeCompleted"],
        rule: "Defaults to false, so the default read is work in flight. A project with no children at all is never excluded by it — that row is broken rather than finished, and hiding it is what this read exists to avoid.",
      },
      {
        fields: ["includeArchived"],
        rule: "Defaults to false: an archived project is not a card, and archived descendants are counted by no rollup number. Pass it to audit what was archived — it widens the grid and the counts together, so a card's total always agrees with the tree beneath it.",
      },
    ],
    example: { includeCompleted: false },
  },
  async handler(ctx: ServiceContext, input: GetProjectsInput): Promise<GetProjectsOutput> {
    // The projects table is aliased `"Item"` in the `roots` CTE below rather
    // than something shorter, so `areaFilterCondition` — which names that
    // alias — composes here unchanged. Reusing the fragment is the point:
    // an area filter that meant something subtly different on this screen
    // than on the board is exactly what having one exported condition
    // prevents.
    const where: string[] = [`"Item"."kind" = 'project'::"ItemKind"`];
    const values: unknown[] = [];

    // Archived roots are not cards (MILESTONES.md #137). Parameterless by
    // construction, so it can sit at any position in this list without
    // disturbing the `$n` numbering the conditions below are counting on —
    // see `NOT_ARCHIVED_CONDITION`. `"Item"` is the alias the `roots` CTE
    // gives this table, the same one `areaFilterCondition` names.
    if (!input.includeArchived) where.push(`"Item".${NOT_ARCHIVED_CONDITION}`);

    if (input.area !== undefined) {
      values.push(input.area);
      // Matches ANY of the item's areas, not only its primary one — see
      // `areaFilterCondition` (../items/area-filter.ts) for why.
      where.push(areaFilterCondition(values.length));
    }
    if (input.repo !== undefined) {
      values.push(input.repo);
      where.push(`"Item"."repo" = $${values.length}`);
    }

    if (input.cursor !== undefined) {
      // Keyset pagination on `("createdAt", "id")` descending — the pair the
      // final ORDER BY sorts by, compared in the same direction. Applied in
      // the `roots` CTE so the recursive subtree walk only descends through
      // the projects this page can actually contain, rather than rolling up
      // every project in the store and discarding most of the work.
      const cursorRows = await ctx.db.$queryRawUnsafe<{ createdAt: Date | string }[]>(
        `SELECT "createdAt" FROM "Item" WHERE "id" = $1`,
        input.cursor,
      );
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        values.push(cursorRow.createdAt, input.cursor);
        where.push(
          `("Item"."createdAt", "Item"."id") < ($${values.length - 1}::timestamptz, $${values.length})`,
        );
      }
    }

    // Archived descendants are counted by no rollup number — applied to
    // **both** arms of the recursion, because each arm is the only one that
    // can reach a different row.
    //
    // The seed arm covers an archived *direct child* of a project: it is
    // found by the seed and never by the recursion, so dropping the filter
    // there counts it. The recursive arm covers an archived row deeper
    // down — the smallest case is an archived **grandchild under a live
    // child**, which the seed never sees, so dropping the filter there
    // counts it no matter what the seed does.
    //
    // Note that an archived *mid* node needs no separate argument: the seed
    // filter excludes it, and excluding it from the seed also stops the
    // recursion descending through it, so its whole subtree drops with it.
    // That is why the grandchild-under-a-live-parent case is the one that
    // pins the recursive arm — the recursion has to actually run through a
    // *live* parent for that filter to be the thing doing the work.
    // Covered by "does not count an archived grandchild under a live
    // child" in tests/item-archive.test.ts, which is the test that fails
    // when this filter is removed from the `UNION ALL` half alone.
    const descendantFilter = input.includeArchived ? "" : ` AND i.${NOT_ARCHIVED_CONDITION}`;

    // **The whole rollup, in one statement.**
    //
    // `subtree` seeds with the direct children of every matching project at
    // once and carries `rootId` down through each level, so a descendant at
    // any depth aggregates against the project it belongs to. The `LEFT
    // JOIN` is what keeps a childless project in the result: an inner join
    // would drop precisely the rows this read is required to surface, which
    // would be the "silently hidden" failure with a query plan as its
    // excuse.
    //
    // Grouping is by the project's own columns, so one row comes back per
    // project regardless of how large its subtree is.
    const rows = await ctx.db.$queryRawUnsafe<RawProjectRollupRow[]>(
      `WITH RECURSIVE roots AS (
           SELECT "Item"."id" FROM "Item" WHERE ${where.join(" AND ")}
         ),
         subtree AS (
           SELECT i."id", i."parentId" AS "rootId"
           FROM "Item" i
           WHERE i."parentId" IN (SELECT "id" FROM roots)${descendantFilter}
           UNION ALL
           SELECT i."id", s."rootId"
           FROM "Item" i JOIN subtree s ON i."parentId" = s."id"${descendantFilter}
         )
         SELECT p."id" AS "id",
           p."title" AS "title",
           p."headline" AS "headline",
           p."area" AS "area",
           p."repo" AS "repo",
           p."priority"::text AS "priority",
           p."updatedAt" AS "updatedAt",
           max(d."updatedAt") AS "lastChildActivity",
           count(d."id")::bigint AS "total",
           ${STATE_COUNT_COLUMNS}
         FROM "Item" p
         LEFT JOIN subtree s ON s."rootId" = p."id"
         LEFT JOIN "Item" d ON d."id" = s."id"
         WHERE p."id" IN (SELECT "id" FROM roots)
         GROUP BY p."id", p."title", p."headline", p."area", p."repo", p."priority", p."updatedAt",
           p."createdAt"
         ORDER BY p."createdAt" DESC, p."id" DESC
         LIMIT $${values.length + 1}`,
      ...values,
      // **The SQL bound is a ceiling on work, not the page itself.**
      // `includeCompleted` is applied in JS below (it needs the rolled-up
      // counts, which only exist after the aggregate), so a raw `LIMIT
      // limit + 1` here would hand back a short page whenever finished
      // projects fell inside it — the page would look like the last one
      // while more matched. Reading `MAX_LIMIT` rows caps the query's cost
      // while leaving enough candidates that the post-filter page is full
      // whenever the store can fill it.
      MAX_LIMIT + 1,
    );

    const rollups: ProjectRollup[] = [];
    for (const row of rows) {
      const counts = countsFrom(row);
      const total = toNumber(row.total);
      const childless = total === 0;
      // Terminal states are exactly those mapping to the completed column
      // (`board/columns.ts`), summed from the distribution rather than
      // counted again in SQL — one source for both numbers.
      const finished = counts.merged + counts.research_done + counts.wont_do + counts.cancelled;

      // Finished means every descendant is over AND there is at least one.
      // The `!childless` half is what keeps a childless project out of this
      // exclusion: `0 === 0` is true, so without it the default read would
      // hide exactly the rows this operation is required to surface.
      if (!input.includeCompleted && !childless && finished === total) continue;

      const lastChildActivity = isoOrStringOrNull(row.lastChildActivity);
      const ownUpdatedAt = isoOrString(row.updatedAt);
      rollups.push({
        id: row.id,
        title: row.title,
        headline: row.headline,
        area: row.area,
        repo: row.repo,
        priority: row.priority,
        total,
        merged: counts.merged,
        finished,
        counts,
        // Null, not zero, when there is nothing to be a ratio of — see the
        // module header.
        progress: childless ? null : counts.merged / total,
        childless,
        // ISO 8601 sorts lexicographically in the same order it sorts
        // chronologically, so the later of the two is a string comparison
        // rather than two `Date` allocations per project.
        lastActivity:
          lastChildActivity !== null && lastChildActivity > ownUpdatedAt
            ? lastChildActivity
            : ownUpdatedAt,
        assignments: [],
      });
    }

    // Live crew for every returned project in **one** statement, after the
    // list is final — the same shape and the same SQL constant `get_board`
    // uses for its cards. Skipped entirely when nothing matched, so an empty
    // result costs no second round trip.
    // The page is taken **after** the `includeCompleted` filter, so a page
    // is full whenever there are that many matching projects — see the
    // `LIMIT` above for why the SQL cannot do this itself. Live crew is
    // then fetched for the page only, never for the discarded candidates.
    const hasMore = rollups.length > input.limit;
    const paged = hasMore ? rollups.slice(0, input.limit) : rollups;
    const nextCursor = hasMore ? (paged[paged.length - 1]?.id ?? null) : null;

    const ids = paged.map((project) => project.id);
    if (ids.length === 0) {
      return { projects: paged, childlessCount: 0, nextCursor };
    }

    const assignmentRows = await ctx.db.$queryRawUnsafe<RawBoardAssignmentRow[]>(
      LIVE_BOARD_ASSIGNMENTS_SQL,
      ids,
    );
    const assignmentsByItem = groupBoardAssignmentsByItem(assignmentRows);

    const projects = paged.map((project) => ({
      ...project,
      // `?? []` is what makes "nobody holds this" an empty array rather than
      // an absent field — the same distinction the board draws.
      assignments: assignmentsByItem.get(project.id) ?? [],
    }));

    return {
      projects,
      childlessCount: projects.filter((project) => project.childless).length,
      nextCursor,
    };
  },
});
