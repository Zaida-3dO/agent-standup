// `get_project_detail` — one project, with everything the page that opens
// it needs to answer *"what is under this, and what is stuck"*.
// MILESTONES.md #75.
//
// ── Why a derived state has to arrive with its evidence ─────────────────
//
// A project has no state of its own; its column is derived from its
// children (DECISIONS.md §13c, `board/columns.ts`). That derivation is
// correct and it is also lossy: `in_progress` is the answer to "which
// column", and it throws away the only things that make the answer
// actionable — how the children are spread across states, and *which
// child* produced that reading.
//
// So this operation returns the rollup **together with** the two facts a
// reader would otherwise have to open every child to reconstruct:
//
//   - `counts` — the full distribution, the same twelve-value vocabulary
//     `get_projects` returns, for the same reason it does: collapsing to
//     four columns on the server is irreversible on the client.
//   - `causingChild` — the single descendant that determines the derived
//     column. `columnForProject` picks the most active column among the
//     descendants; the child this names is one that is actually *in* that
//     column, chosen by the same ranking. Without it "why is this project
//     blocked" is a question the page displays and cannot answer.
//
// `blockedChildren` is returned separately and in full rather than being
// left to the caller to filter out of `children`, because it is the
// question the page exists for and the answer must not depend on the
// client having fetched every child. A project whose children are paged
// would otherwise show an empty blocked list and look healthy.
//
// ── One statement for the subtree, as `get_projects` established ────────
//
// The rollup counts come from the same recursive walk `get_projects` uses,
// narrowed to one root: seed with the project's direct children, follow
// `parentId` down, aggregate with `count(*) FILTER (WHERE …)` per state.
// Nesting is unbounded (SCHEMA.md §1), so a single-level join would
// undercount any project whose work is organised one level deeper.
//
// The children *list* is a second statement and deliberately not the same
// one: the rollup counts every descendant at any depth, while the list a
// page renders is the direct children, with their own subtree summarised
// per row. Trying to serve both from one result set would either return a
// row per descendant — the shape `get_projects` explicitly avoids — or
// lose the depth the counts need.
//
// ── Archived descendants, and the line this read draws ──────────────────
//
// **Resolvability and counting are separate questions, and this read
// answers them differently** (MILESTONES.md #137, the same defect #241
// fixed one level up in `get_projects`).
//
// The top-level lookup deliberately carries **no** archive predicate: this
// is a by-id detail read, and resolving the row you asked for by id is the
// point. #241 established that hiding archived rows from by-id reads breaks
// a load-bearing guarantee — a stale link has to land somewhere real — and
// `get_project_detail` is exempted from the archive sweep in
// `tests/item-archive.test.ts` on exactly that ground.
//
// Its **aggregates** are a different matter. A detail page that resolves an
// archived project is correct; one that reports twelve children when three
// of them are archived is not, because the archive is the installation
// saying those rows should never have existed. So every subtree query below
// filters archived descendants while the lookup above does not.
//
// Four queries carry the predicate, and the two recursive ones carry it on
// **both arms**: filtering only the seed keeps counting the children of an
// archived child, and filtering only the recursive arm keeps counting the
// archived child itself. Either alone leaves a page whose total disagrees
// with the tree beneath it.
//
// The `activity` walk is the one deliberate asymmetry. It is seeded with
// the project's *own* row (`"id" = $1`, not `"parentId" = $1`), so its seed
// stays unfiltered for the same reason the lookup does — the events of the
// project you asked for are part of resolving it, and an archived project's
// activity feed is frequently the thing that explains the archive. Its
// recursive arm is filtered, so an archived *descendant's* events stop
// appearing.
//
// ── The repair advice, and why the server owns it ───────────────────────
//
// A childless project is structurally stuck: it has no state to transition
// and no child whose completion would resolve it. `retype_to_task` and
// `reparent_item` fix that. But repairing an item makes it
// **transitionable**, which is not the same as **closeable** — an item
// whose work is already done then meets `merge.requires_commit` and
// `merge.requires_approving_code_review`, and the second of those has an
// alternative satisfier (`historical_verification`) that only exists while
// an environment window is open (`guards/historical-verification-enabled.ts`).
//
// Whether that window is open is a fact only the server can see, and a UI
// that offered a repair without it would be promising a route that ends in
// a refusal the user was never warned about. So the answer travels with
// the read, as `repair.historicalVerificationAvailable`, rather than being
// guessed on the client or — worse — omitted.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { NotFoundError } from "../errors";
import { ITEM_STATES, type ItemStateValue } from "../state-machine/states";
import { columnForProject, columnForState, type BoardColumn } from "../board/columns";
import { isHistoricalVerificationEnabled } from "../guards/historical-verification-enabled";
import { NOT_ARCHIVED_CONDITION } from "../items/row";
import {
  LIVE_BOARD_ASSIGNMENTS_SQL,
  groupBoardAssignmentsByItem,
  isoOrString,
  isoOrStringOrNull,
  type BoardAssignment,
  type RawBoardAssignmentRow,
} from "../items/assignment-view";

/** Counts of a project's descendants by state — every state present, so zero is distinguishable from unreported. */
export type StateCounts = Readonly<Record<ItemStateValue, number>>;

/**
 * One direct child, as the page's list renders it.
 *
 * Carries its own subtree rollup (`total`/`merged`) so a child that is
 * itself a project shows progress rather than an empty row — a nested
 * project has no state of its own either, and rendering its stored `state`
 * would display the leftover default `create_item` writes.
 */
export interface ProjectChild {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly kind: string;
  /** The stored state. Meaningless for a child that is itself a project — read `column` instead. */
  readonly state: string;
  readonly priority: string;
  readonly area: string;
  readonly repo: string | null;
  /** The column this child belongs in: its own state's column, or — for a nested project — derived from *its* children. */
  readonly column: BoardColumn;
  /** Why this child is blocked, when it is. Null otherwise. */
  readonly blockedReason: string | null;
  /** Descendants of this child, at any depth. Zero for a leaf task, and for a childless nested project. */
  readonly total: number;
  readonly merged: number;
  /** True when this child is a project with no children — structurally stuck, same as the root case. */
  readonly childless: boolean;
  readonly updatedAt: string;
  readonly assignments: readonly BoardAssignment[];
}

/**
 * The derived reading, with the evidence that produced it.
 *
 * Three fields rather than one because the column alone is the lossy part:
 * see the module header.
 */
export interface DerivedStateReading {
  /** The project's column, derived from its descendants — `columnForProject`. */
  readonly column: BoardColumn;
  /** The full distribution beneath it. */
  readonly counts: StateCounts;
  /**
   * The one descendant that put the project in `column`, or null when there
   * are none. Names a child actually in the winning column, so a reader can
   * open it directly.
   */
  readonly causingChild: {
    readonly id: string;
    readonly title: string;
    readonly state: string;
    readonly blockedReason: string | null;
  } | null;
}

/** What a repair of this project would and would not achieve. */
export interface RepairAdvice {
  /** True when this project has no children at all — the condition both repairs address. */
  readonly childless: boolean;
  /**
   * Whether the merge gate would accept a `historical_verification` in place
   * of an approving `code_review` right now.
   *
   * **This is the difference between a repair that can be finished and one
   * that dead-ends.** Retyping makes an item transitionable; reaching
   * `merged` still needs a commit artifact and an approving code review, and
   * for work that shipped before this installation existed the only honest
   * route to the second is a `historical_verification` — which exists only
   * while `ENABLE_HISTORICAL_VERIFICATION` is set. False here means a repair
   * is still worth doing (the item becomes workable) but that an
   * already-shipped item cannot be closed on it, and the UI must say so
   * before the user commits.
   */
  readonly historicalVerificationAvailable: boolean;
}

export interface GetProjectDetailOutput {
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly headline: string | null;
    readonly area: string;
    readonly repo: string | null;
    readonly priority: string;
    readonly kind: string;
  };
  readonly derived: DerivedStateReading;
  readonly total: number;
  readonly merged: number;
  readonly finished: number;
  /** Merged over total, `0`–`1`, or **null when there are no children** — never zero. See `get_projects`. */
  readonly progress: number | null;
  readonly childless: boolean;
  /** Newest `updatedAt` across the project and its whole subtree. */
  readonly lastActivity: string;
  readonly children: readonly ProjectChild[];
  /** Every descendant in `blocked`, at any depth — the question the page is usually opened to answer. */
  readonly blockedChildren: readonly BlockedDescendant[];
  readonly assignments: readonly BoardAssignment[];
  readonly activity: readonly ProjectActivityEntry[];
  readonly repair: RepairAdvice;
}

/** A blocked descendant, at any depth — with what it is blocked on. */
export interface BlockedDescendant {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly blockedOnType: string | null;
  readonly area: string;
  readonly updatedAt: string;
}

/** One entry in the project's recent activity — events across the whole subtree. */
export interface ProjectActivityEntry {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly body: string | null;
  /** Which item in the subtree the event happened on — an activity feed over a tree is unreadable without it. */
  readonly itemId: string;
  readonly itemTitle: string;
}

const inputSchema = z
  .object({
    id: z.string().trim().min(1, "id is required"),
    /**
     * How many activity entries to return. Bounded by default for the
     * reason every read here is (MILESTONES.md #103): a subtree's event
     * history grows without limit and a page renders a screenful.
     */
    activityLimit: z.number().int().min(1).max(200).default(30),
    /**
     * How many direct children to return. A project with hundreds of
     * children would otherwise make this read the shape #103 exists to
     * prevent. `blockedChildren` is deliberately **not** bounded by this —
     * see the module header.
     */
    childLimit: z.number().int().min(1).max(500).default(200),
    /**
     * Whether to include archived descendants in the children list, the
     * rollup counts, the blocked list and the activity feed.
     *
     * Defaults to `false`, following `get_projects` and `list_areas`: an
     * archived row is the installation saying it should never have existed,
     * so it is not a child and it is counted by no rollup number.
     *
     * It widens **every** aggregate together rather than one of them,
     * deliberately — a flag that restored archived children to the list but
     * not to `total` (or the reverse) would produce a page whose numbers
     * disagreed with the rows underneath them, which is the same class of
     * wrong number this predicate exists to remove.
     *
     * **It does not affect the top-level lookup, which has no archive
     * predicate to relax** — an archived project resolves by id at either
     * setting. See the module header.
     */
    includeArchived: z.boolean().default(false),
  })
  .strict();

export type GetProjectDetailInput = z.infer<typeof inputSchema>;

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/**
 * The `count(*) FILTER (WHERE …)` list, one column per state.
 *
 * Built from `ITEM_STATES` so a thirteenth state cannot be added to the
 * vocabulary and silently omitted from the distribution. Interpolated into
 * SQL, which is safe **only** because these come from a module-level
 * constant and never from input.
 */
const STATE_COUNT_COLUMNS = ITEM_STATES.map(
  (state) =>
    `count(*) FILTER (WHERE d."state" = '${state}'::"ItemState")::bigint AS "count_${state}"`,
).join(",\n           ");

interface RawRollupRow {
  updatedAt: Date | string;
  lastChildActivity: Date | string | null;
  total: bigint | number;
  [countColumn: string]: unknown;
}

function countsFrom(row: Record<string, unknown>): StateCounts {
  const counts = {} as Record<ItemStateValue, number>;
  for (const state of ITEM_STATES) {
    counts[state] = toNumber(row[`count_${state}`]);
  }
  return counts;
}

/**
 * Every descendant state present, as a flat list — the input
 * `columnForProject` ranks.
 *
 * Expanded from the counts rather than queried again: a state with three
 * children contributes three entries, which is what the counts already
 * say. `columnForProject` only ranks, so one entry per present state would
 * give the same answer — but expanding faithfully keeps this a pure
 * restatement of the distribution rather than a second, subtly different
 * summary of it.
 */
function descendantStatesFrom(counts: StateCounts): ItemStateValue[] {
  const states: ItemStateValue[] = [];
  for (const state of ITEM_STATES) {
    if (counts[state] > 0) states.push(state);
  }
  return states;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getProjectDetail = defineOperation({
  name: "get_project_detail",
  kind: "read",
  summary:
    "One project in full: its derived column, the distribution of its children by state and the child that caused that reading, direct children, every blocked descendant at any depth, live crew, recent subtree activity, and whether a childless project repairs to a closeable or only a transitionable item. Archived descendants are excluded from the children list and every rollup number — pass includeArchived to audit them. An archived project still resolves by id.",
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["id"],
        rule: "Must name a project. A task or subtask is refused rather than rolled up — a task's state is its own, so there is nothing to derive and no children to derive it from.",
      },
      {
        fields: ["activityLimit", "childLimit"],
        rule: "Both bounded. blockedChildren is deliberately NOT bounded by childLimit — a blocked child hidden by paging is the one failure this read exists to prevent.",
      },
      {
        fields: ["includeArchived"],
        rule: "Defaults to false: an archived descendant is not a child and is counted by no rollup number. Pass it to audit what was archived — it widens the children list, the counts, the blocked list and the activity feed together, so the page's numbers always agree with the rows beneath them. It does not affect whether the project itself resolves: an archived project is returned by id either way.",
      },
    ],
    example: { id: "a-project-id", activityLimit: 30 },
  },
  async handler(
    ctx: ServiceContext,
    input: GetProjectDetailInput,
  ): Promise<GetProjectDetailOutput> {
    const projectRows = await ctx.db.$queryRawUnsafe<
      {
        id: string;
        title: string;
        headline: string | null;
        area: string;
        repo: string | null;
        priority: string;
        kind: string;
        updatedAt: Date | string;
      }[]
    >(
      `SELECT "id", "title", "headline", "area", "repo", "priority"::text AS "priority",
              "kind"::text AS "kind", "updatedAt"
         FROM "Item" WHERE "id" = $1`,
      input.id,
    );
    const project = projectRows[0];
    if (project === undefined) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }
    if (project.kind !== "project") {
      // Refused rather than served with an empty rollup. A task has a state
      // of its own, so "the distribution of its children" is not a smaller
      // version of this answer — it is a different question, and returning
      // zeros would let a caller render a task as a project with no work
      // under it, which is exactly the misreading `childless` exists to
      // prevent.
      throw new NotFoundError(
        `Item ${input.id} is a ${project.kind}, not a project — it has a state of its own rather than one derived from children. Read it with get_item_detail.`,
        { fields: ["id"] },
      );
    }

    // Archived descendants are counted by none of the aggregates below —
    // see the module header. Parameterless by construction, so it can be
    // appended to any condition without disturbing `$n` numbering.
    const descendantFilter = input.includeArchived ? "" : ` AND i.${NOT_ARCHIVED_CONDITION}`;
    // The same predicate for the two statements that alias the item table as
    // something other than `i` — the direct-child SELECT (`c`) and the
    // blocked-descendant join (`d`). Separate constants rather than a
    // string replace, so an alias change is a compile-time edit here rather
    // than a filter that silently stops matching.
    const childFilter = input.includeArchived ? "" : ` AND c.${NOT_ARCHIVED_CONDITION}`;

    // The subtree rollup — one statement, the same recursive shape
    // `get_projects` walks, narrowed to this root.
    const rollupRows = await ctx.db.$queryRawUnsafe<RawRollupRow[]>(
      `WITH RECURSIVE subtree AS (
           SELECT i."id" FROM "Item" i WHERE i."parentId" = $1${descendantFilter}
           UNION ALL
           SELECT i."id" FROM "Item" i JOIN subtree s ON i."parentId" = s."id"${descendantFilter}
         )
         SELECT max(d."updatedAt") AS "lastChildActivity",
           count(d."id")::bigint AS "total",
           ${STATE_COUNT_COLUMNS}
         FROM subtree s JOIN "Item" d ON d."id" = s."id"`,
      input.id,
    );
    const rollup = rollupRows[0];
    const counts = rollup === undefined ? countsFrom({}) : countsFrom(rollup);
    const total = rollup === undefined ? 0 : toNumber(rollup.total);
    const childless = total === 0;
    const finished = counts.merged + counts.research_done + counts.wont_do + counts.cancelled;

    const ownUpdatedAt = isoOrString(project.updatedAt);
    const lastChildActivity =
      rollup === undefined ? null : isoOrStringOrNull(rollup.lastChildActivity);
    const lastActivity =
      lastChildActivity !== null && lastChildActivity > ownUpdatedAt
        ? lastChildActivity
        : ownUpdatedAt;

    // The direct children, each with its own subtree counted. The
    // correlated aggregate is over the child's descendants only, so a
    // nested project's row shows its own progress rather than the root's.
    const childRows = await ctx.db.$queryRawUnsafe<
      {
        id: string;
        title: string;
        headline: string | null;
        kind: string;
        state: string;
        priority: string;
        area: string;
        repo: string | null;
        blockedReason: string | null;
        updatedAt: Date | string;
        total: bigint | number;
        merged: bigint | number;
        childStates: string[] | null;
      }[]
    >(
      // `kids` carries no archive predicate on purpose. It feeds only
      // `descendants`, and the outer SELECT's own `childFilter` already
      // drops an archived direct child from the result — so a predicate here
      // could not change a single returned row. It was written with one and
      // removed after the mutant proved it unkillable: a filter that cannot
      // affect output is not a safety net, it is a line asserting a
      // guarantee it does not provide.
      `WITH RECURSIVE kids AS (
           SELECT i."id" FROM "Item" i WHERE i."parentId" = $1
         ),
         descendants AS (
           SELECT i."id", i."parentId" AS "rootId", i."state"
           FROM "Item" i WHERE i."parentId" IN (SELECT "id" FROM kids)${descendantFilter}
           UNION ALL
           SELECT i."id", d."rootId", i."state"
           FROM "Item" i JOIN descendants d ON i."parentId" = d."id"${descendantFilter}
         )
         SELECT c."id", c."title", c."headline", c."kind"::text AS "kind",
                c."state"::text AS "state", c."priority"::text AS "priority",
                c."area", c."repo", c."blockedReason", c."updatedAt",
                count(d."id")::bigint AS "total",
                count(*) FILTER (WHERE d."state" = 'merged'::"ItemState")::bigint AS "merged",
                array_remove(array_agg(d."state"::text), NULL) AS "childStates"
           FROM "Item" c
           LEFT JOIN descendants d ON d."rootId" = c."id"
          WHERE c."parentId" = $1${childFilter}
          GROUP BY c."id", c."title", c."headline", c."kind", c."state", c."priority",
                   c."area", c."repo", c."blockedReason", c."updatedAt", c."createdAt"
          ORDER BY c."createdAt" ASC, c."id" ASC
          LIMIT $2`,
      input.id,
      input.childLimit,
    );

    // Every blocked descendant at any depth — NOT filtered from `children`,
    // and not bounded by `childLimit`. See the module header.
    //
    // The `blocked` WHERE below carries no archive predicate of its own, on
    // purpose: both arms of the `subtree` walk are already filtered, so no
    // archived row reaches that join to be tested. One was written there and
    // removed once the mutant proved it unkillable — a filter that cannot
    // change the output asserts a guarantee it does not provide. The
    // exclusion is covered by "does not report an archived descendant as a
    // blocked child", which fails when the seed's filter is dropped.
    const blockedRows = await ctx.db.$queryRawUnsafe<
      {
        id: string;
        title: string;
        state: string;
        blockedReason: string | null;
        blockedOnType: string | null;
        area: string;
        updatedAt: Date | string;
      }[]
    >(
      `WITH RECURSIVE subtree AS (
           SELECT i."id" FROM "Item" i WHERE i."parentId" = $1${descendantFilter}
           UNION ALL
           SELECT i."id" FROM "Item" i JOIN subtree s ON i."parentId" = s."id"${descendantFilter}
         )
         SELECT d."id", d."title", d."state"::text AS "state", d."blockedReason",
                d."blockedOnType"::text AS "blockedOnType", d."area", d."updatedAt"
           FROM subtree s JOIN "Item" d ON d."id" = s."id"
          WHERE d."state" = 'blocked'::"ItemState"
          ORDER BY d."updatedAt" DESC, d."id" ASC`,
      input.id,
    );

    // Recent activity across the whole subtree, including the project's own
    // row — a project's events are rare but they are the ones that explain
    // a retype or a reparent, which is exactly what a reader of a repaired
    // item needs to see.
    const activityRows = await ctx.db.$queryRawUnsafe<
      {
        id: bigint | number | string;
        ts: Date | string;
        type: string;
        actorType: string;
        actorId: string | null;
        body: string | null;
        itemId: string;
        itemTitle: string;
      }[]
    >(
      // The seed is the project's OWN row (`"id" = $1`), so it carries no
      // archive predicate — the same by-id resolvability the top-level
      // lookup preserves, and an archived project's own activity is usually
      // what explains the archive. Only the recursive arm is filtered, so an
      // archived descendant's events stop appearing. See the module header.
      `WITH RECURSIVE subtree AS (
           SELECT "id" FROM "Item" WHERE "id" = $1
           UNION ALL
           SELECT i."id" FROM "Item" i JOIN subtree s ON i."parentId" = s."id"${descendantFilter}
         )
         SELECT e."id"::text AS "id", e."ts", e."type"::text AS "type",
                e."actorType"::text AS "actorType", e."actorId", e."body",
                e."itemId", i."title" AS "itemTitle"
           FROM "Event" e
           JOIN subtree s ON s."id" = e."itemId"
           JOIN "Item" i ON i."id" = e."itemId"
          ORDER BY e."id" DESC
          LIMIT $2`,
      input.id,
      input.activityLimit,
    );

    // Live crew for the project and every direct child in one statement —
    // the same SQL constant `get_board` and `get_projects` use, so the three
    // reads cannot disagree about what "who holds this" means.
    const assignmentIds = [project.id, ...childRows.map((child) => child.id)];
    const assignmentRows = await ctx.db.$queryRawUnsafe<RawBoardAssignmentRow[]>(
      LIVE_BOARD_ASSIGNMENTS_SQL,
      assignmentIds,
    );
    const assignmentsByItem = groupBoardAssignmentsByItem(assignmentRows);

    const children: ProjectChild[] = childRows.map((child) => {
      const childTotal = toNumber(child.total);
      const nestedProject = child.kind === "project";
      const states = (child.childStates ?? []) as ItemStateValue[];
      return {
        id: child.id,
        title: child.title,
        headline: child.headline,
        kind: child.kind,
        state: child.state,
        priority: child.priority,
        area: child.area,
        repo: child.repo,
        // A nested project's column comes from ITS children, never from its
        // own stored state — that value is the leftover default every item
        // is created with, and reading it here would reintroduce exactly the
        // second source of truth DECISIONS.md §13c rules out.
        column: nestedProject
          ? columnForProject(states)
          : columnForState(child.state as ItemStateValue),
        blockedReason: child.blockedReason,
        total: childTotal,
        merged: toNumber(child.merged),
        childless: nestedProject && childTotal === 0,
        updatedAt: isoOrString(child.updatedAt),
        assignments: assignmentsByItem.get(child.id) ?? [],
      };
    });

    const column = columnForProject(descendantStatesFrom(counts));

    return {
      project: {
        id: project.id,
        title: project.title,
        headline: project.headline,
        area: project.area,
        repo: project.repo,
        priority: project.priority,
        kind: project.kind,
      },
      derived: {
        column,
        counts,
        causingChild: causingChildFor(column, childRows, blockedRows),
      },
      total,
      merged: counts.merged,
      finished,
      // Null, not zero, when there is nothing to be a ratio of — the same
      // honesty requirement `get_projects` documents at length.
      progress: childless ? null : counts.merged / total,
      childless,
      lastActivity,
      children,
      blockedChildren: blockedRows.map((row) => ({
        id: row.id,
        title: row.title,
        state: row.state,
        blockedReason: row.blockedReason,
        blockedOnType: row.blockedOnType,
        area: row.area,
        updatedAt: isoOrString(row.updatedAt),
      })),
      assignments: assignmentsByItem.get(project.id) ?? [],
      activity: activityRows.map((row) => ({
        id: String(row.id),
        ts: isoOrString(row.ts),
        type: row.type,
        actorType: row.actorType,
        actorId: row.actorId,
        body: row.body,
        itemId: row.itemId,
        itemTitle: row.itemTitle,
      })),
      repair: {
        childless,
        historicalVerificationAvailable: isHistoricalVerificationEnabled(),
      },
    };
  },
});

/**
 * The one child that put the project in `column`.
 *
 * Prefers a **blocked descendant at any depth** when the winning column is
 * `waiting`, because that is the case a reader is nearly always chasing and
 * the culprit is frequently a grandchild — restricting to direct children
 * would report "waiting" with no visible cause. For every other column it
 * names the most recently touched direct child actually in that column,
 * which is the one whose activity produced the current reading.
 *
 * Returns null rather than a placeholder when nothing matches: a childless
 * project genuinely has no causing child, and inventing one would make the
 * page assert a cause that does not exist.
 */
function causingChildFor(
  column: BoardColumn,
  childRows: readonly {
    id: string;
    title: string;
    kind: string;
    state: string;
    blockedReason: string | null;
    updatedAt: Date | string;
  }[],
  blockedRows: readonly {
    id: string;
    title: string;
    state: string;
    blockedReason: string | null;
  }[],
): DerivedStateReading["causingChild"] {
  if (column === "waiting") {
    const blocked = blockedRows[0];
    if (blocked !== undefined) {
      return {
        id: blocked.id,
        title: blocked.title,
        state: blocked.state,
        blockedReason: blocked.blockedReason,
      };
    }
  }
  // Only tasks and subtasks are considered: a nested project's stored
  // `state` is the leftover default, so matching on it would name a child
  // that is not really in that column at all.
  const inColumn = childRows.filter(
    (child) => child.kind !== "project" && columnForState(child.state as ItemStateValue) === column,
  );
  if (inColumn.length === 0) return null;
  let newest = inColumn[0]!;
  for (const child of inColumn) {
    if (isoOrString(child.updatedAt) > isoOrString(newest.updatedAt)) newest = child;
  }
  return {
    id: newest.id,
    title: newest.title,
    state: newest.state,
    blockedReason: newest.blockedReason,
  };
}
