// `get_fleet` — every LIVE assignment in the whole installation, in one
// read. M10 T16 ("Fleet: presence on cards, the fleet page, and stale-claim
// recovery"): *"who is doing what right now, and is anything wedged?"*.
//
// ── Why this is its own operation, not a filter on something else ───────
//
// `get_board` and `get_projects` both already resolve ownership — but only
// for the items they were about to return anyway, via
// `LIVE_BOARD_ASSIGNMENTS_SQL` keyed on `itemId = ANY(entryIds)`. Neither
// can answer "show me every live assignment" without first reading every
// item in the store, which is not what either read is for and would make
// the fleet page pay the cost of a full board fetch to render a table of a
// few dozen rows. This operation inverts the query: start from
// `Assignment` where `releasedAt IS NULL`, and join outward to the one item
// each row belongs to — never the other way around.
//
// ── Why the FULL detail shape, not the board's slim one ─────────────────
//
// A card's presence dot needs seven scalars (`toBoardAssignment`'s shape).
// The fleet page is the screen a person opens specifically to answer
// "which machine, which branch, which session" — `machine`, `branch`,
// `model`, `sessionId` are the whole reason it exists as a separate screen
// from the board. So this reads the same full column set
// `ALL_ITEM_ASSIGNMENTS_SQL` already selects for one item's detail view,
// just without the `WHERE itemId = $1` — see `LIVE_FLEET_ASSIGNMENTS_SQL`
// below, which is that same column list against `releasedAt IS NULL`
// instead.
//
// ── One statement, not one query per row ─────────────────────────────────
//
// Every assignment carries its own item's `title`, `kind` and `state` in
// the same SELECT (a second `LEFT JOIN` onto `Item`), so the fleet table
// never issues a follow-up read per row to learn what an assignment is
// *for*. A install with a few hundred live claims is still one query.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { isoOrString, type ItemDetailAssignment } from "../items/assignment-view";
import type { HolderType, Liveness, Role } from "../../claims";

const inputSchema = z.object({}).strict();

export type GetFleetInput = z.infer<typeof inputSchema>;

/** One live assignment, with the one fact `ItemDetailAssignment` does not carry: what item it is on. */
export interface FleetAssignment extends ItemDetailAssignment {
  readonly itemId: string;
  readonly itemTitle: string;
  readonly itemKind: "project" | "task" | "subtask";
  /** The item's own stored state — see `BoardItem.state`'s own note: a project's is a creation leftover. */
  readonly itemState: string;
}

export interface GetFleetOutput {
  readonly assignments: readonly FleetAssignment[];
}

interface RawFleetAssignmentRow {
  itemId: string;
  itemTitle: string;
  itemKind: string;
  itemState: string;
  holderId: string;
  holderType: HolderType;
  personDisplayName: string | null;
  role: Role;
  roleCustom: string | null;
  liveness: Liveness;
  lastActive: Date | string;
  id: string;
  machine: string;
  branch: string | null;
  worktree: string | null;
  model: string | null;
  effort: string | null;
  sessionId: string;
  rootSessionId: string;
  pid: number | null;
  claimedAt: Date | string;
}

/**
 * Every live assignment, full detail columns, joined to its item's title,
 * kind and state.
 *
 * `releasedAt` is not selected — every row here is by definition live
 * (`releasedAt IS NULL` is the WHERE clause itself), so the column would be
 * `NULL` on every row and `toFleetAssignment` fills it in as such rather
 * than reading it off the wire. Ordered oldest-claimed-first, matching
 * `LIVE_BOARD_ASSIGNMENTS_SQL`'s own ordering, so an item held by two
 * holders at once lists them in the order they took it.
 */
export const LIVE_FLEET_ASSIGNMENTS_SQL = `SELECT
   i."id" AS "itemId",
   i."title" AS "itemTitle",
   i."kind" AS "itemKind",
   i."state" AS "itemState",
   a."holderId" AS "holderId",
   a."holderType" AS "holderType",
   p."displayName" AS "personDisplayName",
   a."role" AS "role",
   a."roleCustom" AS "roleCustom",
   a."liveness" AS "liveness",
   a."lastActive" AS "lastActive",
   a."id" AS "id",
   a."machine" AS "machine",
   a."branch" AS "branch",
   a."worktree" AS "worktree",
   a."model" AS "model",
   a."effort" AS "effort",
   a."sessionId" AS "sessionId",
   a."rootSessionId" AS "rootSessionId",
   a."pid" AS "pid",
   a."claimedAt" AS "claimedAt"
   FROM "Assignment" a
   JOIN "Item" i ON i."id" = a."itemId"
   LEFT JOIN "Person" p ON p."id" = a."holderId" AND a."holderType" = 'person'::"HolderType"
   WHERE a."releasedAt" IS NULL
   ORDER BY a."claimedAt" ASC, a."id" ASC`;

function displayNameFor(row: RawFleetAssignmentRow): string {
  return row.personDisplayName ?? row.holderId;
}

/** Maps one raw fleet row to `FleetAssignment`. */
export function toFleetAssignment(row: RawFleetAssignmentRow): FleetAssignment {
  return {
    itemId: row.itemId,
    itemTitle: row.itemTitle,
    itemKind: row.itemKind as "project" | "task" | "subtask",
    itemState: row.itemState,
    holderId: row.holderId,
    holderType: row.holderType,
    displayName: displayNameFor(row),
    role: row.role,
    roleCustom: row.roleCustom,
    liveness: row.liveness,
    lastActive: isoOrString(row.lastActive),
    id: row.id,
    machine: row.machine,
    branch: row.branch,
    worktree: row.worktree,
    model: row.model,
    effort: row.effort,
    sessionId: row.sessionId,
    rootSessionId: row.rootSessionId,
    pid: row.pid === null ? null : Number(row.pid),
    claimedAt: isoOrString(row.claimedAt),
    // Every row here is live by construction (the WHERE clause), so this is
    // never fetched off the wire — see the SQL constant's own header.
    releasedAt: null,
  };
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getFleet = defineOperation({
  name: "get_fleet",
  kind: "read",
  summary:
    "Every live assignment across the whole installation: who holds what, on which machine and branch, and how long since they last reported.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<GetFleetOutput> {
    const rows = await ctx.db.$queryRawUnsafe<RawFleetAssignmentRow[]>(LIVE_FLEET_ASSIGNMENTS_SQL);
    return { assignments: rows.map(toFleetAssignment) };
  },
});
