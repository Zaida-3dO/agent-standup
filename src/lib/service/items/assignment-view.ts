// Live and past ownership, as a *read* returns it — the shape behind "who is
// on this, on what machine, and when did they last do anything".
//
// `Assignment` (SCHEMA.md §2) already records all of it: the holder, the
// role, the session, the machine, the branch, the worktree, the model, the
// effort, and a `liveness` that separates a session still working from one
// that stopped answering. None of it reached a reader. `get_board` took
// `assignee` as a *filter* and returned nothing about who that was, and the
// detail read returned no ownership at all — so a tool whose subject is a
// fleet of agents could not say which agent held anything.
//
// **Two shapes, not one, and the difference is the payload.** A board is
// tens of cards in one response and a detail view is a single item, so they
// can afford very different amounts per row:
//
//   - `BoardAssignment` — what a card draws: who, in what role, alive or
//     not, and when they were last active. Seven short scalars.
//   - `ItemDetailAssignment` — the whole row, because the detail view is
//     the screen that answers "where is this work actually happening":
//     machine, branch, worktree, model, effort, session and pid.
//
// A board that returned the detail shape would carry a worktree path and a
// session id per card for no card that draws them, on a response that has
// already had to be narrowed once for size. So the slim shape is not an
// optimisation applied to the full one — it is its own contract, and the
// SELECT list below is the enforcement: the columns are not read at all.
//
// **Live and released are both ownership, and only one of them is current.**
// `releasedAt IS NULL` is the same predicate `liveAssignments` in claims.ts
// enforces on, so "who a read says holds this" and "who the claim machinery
// says holds this" cannot disagree. Released rows answer a different and
// genuinely asked question — *who had this before it stalled* — so the
// detail read returns them separately rather than mixing them into one list
// a reader would have to re-split by a null check.
//
// **`liveness` is passed through with all four values intact.** `running`,
// `stalled`, `dead` and `superseded` mean four different things — a session
// still working, one that stopped reporting, one known to be gone, and one
// deliberately replaced by a takeover. Collapsing any pair here would push
// the distinction onto every reader to guess back, and `superseded` in
// particular is not a failure at all: it is the *expected* end state of a
// row a takeover replaced.
//
// **A display name is not always a lookup.** An agent's `holderId` **is**
// its crew name (`Agent.name`, handed out by src/lib/agent-names.ts), so it
// is already the string a screen shows. A person's is an opaque id with a
// `Person.displayName` beside it. Rather than make each caller know which
// case it is in, the join resolves it once and `displayName` is always
// populated — falling back to the id when a person row is missing, because
// a read of ownership should not fail on a dangling reference and an id is
// a worse label than a name but a much better one than nothing.

/** Mirrors `Role`, `HolderType` and `Liveness` in schema.prisma. */
import type { HolderType, Liveness, Role } from "../../claims";

/**
 * One live assignment, as a **board card** draws it (MILESTONES.md #109's
 * size discipline applied to a new field).
 *
 * Deliberately missing `machine`, `branch`, `worktree`, `model`, `effort`,
 * `sessionId` and `pid`: no card renders them, and `get_board` has already
 * once been the read that overflowed a context window. See the module
 * header.
 */
export interface BoardAssignment {
  readonly holderId: string;
  readonly holderType: HolderType;
  /** `Person.displayName` for a person; the crew name itself for an agent. Never null — see the module header. */
  readonly displayName: string;
  readonly role: Role;
  /** The free-text role name, set iff `role` is `custom` (SCHEMA.md §2). */
  readonly roleCustom: string | null;
  readonly liveness: Liveness;
  /** ISO 8601. What a "last active 40m ago" label is computed from. */
  readonly lastActive: string;
}

/**
 * One assignment, whole, as the **detail view** shows it — every column that
 * answers "where is this work actually happening".
 *
 * `releasedAt` is present rather than implied by which list the row arrived
 * in: a previous holder's row is only meaningful with the moment it stopped
 * being current, and a live row carrying an explicit `null` is a stronger
 * statement than an absent field.
 */
export interface ItemDetailAssignment extends BoardAssignment {
  readonly id: string;
  readonly machine: string;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly sessionId: string;
  /** Top of the holder's session tree — what "one crew per item" is enforced on (claims.ts). */
  readonly rootSessionId: string;
  readonly pid: number | null;
  readonly claimedAt: string;
  /** Null on a live assignment; the moment ownership ended on a previous holder. */
  readonly releasedAt: string | null;
}

/** The slim projection's raw row, as Postgres returns it. */
export interface RawBoardAssignmentRow {
  itemId: string;
  holderId: string;
  holderType: HolderType;
  personDisplayName: string | null;
  role: Role;
  roleCustom: string | null;
  liveness: Liveness;
  lastActive: Date | string;
}

/** The full projection's raw row. */
export interface RawItemDetailAssignmentRow extends RawBoardAssignmentRow {
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
  releasedAt: Date | string | null;
}

/**
 * `$queryRawUnsafe` deserializes a `timestamptz` as a JS `Date`, so the
 * DB-backed tests can only ever reach that branch — the string passthrough
 * exists for a driver that hands back a string and is covered by calling
 * this directly. Same reasoning, and the same shape, as `isoOrString` in
 * my-work.ts.
 */
export function isoOrString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** As above, for a column that is null on a live row. */
export function isoOrStringOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoOrString(value);
}

/**
 * The `LEFT JOIN` that resolves a holder's display name, and the alias it
 * binds. A person's name lives on `Person`; an agent's `holderId` already
 * is its name, so the join is restricted to `holderType = 'person'` rather
 * than left open — an agent whose crew name happened to collide with a
 * person's id would otherwise be labelled with that person's name.
 */
const PERSON_JOIN = `LEFT JOIN "Person" p ON p."id" = a."holderId" AND a."holderType" = 'person'::"HolderType"`;

/** The slim column list, aliased to `RawBoardAssignmentRow`'s field names. */
const BOARD_ASSIGNMENT_COLUMNS = `a."itemId" AS "itemId",
   a."holderId" AS "holderId",
   a."holderType" AS "holderType",
   p."displayName" AS "personDisplayName",
   a."role" AS "role",
   a."roleCustom" AS "roleCustom",
   a."liveness" AS "liveness",
   a."lastActive" AS "lastActive"`;

/** The full column list — the slim one plus every column a detail view shows. */
const ITEM_DETAIL_ASSIGNMENT_COLUMNS = `${BOARD_ASSIGNMENT_COLUMNS},
   a."id" AS "id",
   a."machine" AS "machine",
   a."branch" AS "branch",
   a."worktree" AS "worktree",
   a."model" AS "model",
   a."effort" AS "effort",
   a."sessionId" AS "sessionId",
   a."rootSessionId" AS "rootSessionId",
   a."pid" AS "pid",
   a."claimedAt" AS "claimedAt",
   a."releasedAt" AS "releasedAt"`;

/**
 * **One** statement for a whole page of items, keyed on `itemId = ANY(...)`.
 *
 * The N+1 this exists to not be: a board page of sixty-eight cards, each
 * fetching its own holder, is sixty-eight round trips added to a read that
 * previously made a fixed handful. `ANY($1::text[])` is a single query
 * whose cost does not grow with the page, and `Assignment_itemId_role_idx`
 * (schema.prisma) is the index it lands on.
 *
 * Ordered by `claimedAt` so an item held by two holders at once — an
 * orchestrator plus a builder, which SCHEMA.md §2 explicitly allows —
 * renders them in the order they took it, not in whatever order the plan
 * produced.
 */
export const LIVE_BOARD_ASSIGNMENTS_SQL = `SELECT ${BOARD_ASSIGNMENT_COLUMNS}
   FROM "Assignment" a
   ${PERSON_JOIN}
   WHERE a."itemId" = ANY($1::text[]) AND a."releasedAt" IS NULL
   ORDER BY a."claimedAt" ASC, a."id" ASC`;

/**
 * Every assignment on **one** item, live and released alike, newest claim
 * first.
 *
 * Both halves in one statement rather than two: they are the same rows off
 * the same index differing only by a null check, and splitting them would
 * pay two round trips to answer one question. The caller partitions on
 * `releasedAt`, which is returned.
 */
export const ALL_ITEM_ASSIGNMENTS_SQL = `SELECT ${ITEM_DETAIL_ASSIGNMENT_COLUMNS}
   FROM "Assignment" a
   ${PERSON_JOIN}
   WHERE a."itemId" = $1
   ORDER BY a."claimedAt" DESC, a."id" DESC`;

/** Resolves the label a screen shows for a holder — see the module header. */
function displayNameFor(row: RawBoardAssignmentRow): string {
  return row.personDisplayName ?? row.holderId;
}

/** Maps one raw slim row. */
export function toBoardAssignment(row: RawBoardAssignmentRow): BoardAssignment {
  return {
    holderId: row.holderId,
    holderType: row.holderType,
    displayName: displayNameFor(row),
    role: row.role,
    roleCustom: row.roleCustom,
    liveness: row.liveness,
    lastActive: isoOrString(row.lastActive),
  };
}

/** Maps one raw full row. */
export function toItemDetailAssignment(row: RawItemDetailAssignmentRow): ItemDetailAssignment {
  return {
    ...toBoardAssignment(row),
    id: row.id,
    machine: row.machine,
    branch: row.branch,
    worktree: row.worktree,
    model: row.model,
    effort: row.effort,
    sessionId: row.sessionId,
    rootSessionId: row.rootSessionId,
    // `pid` is an `Int?`, which the driver hands back as a number, but a
    // driver returning a bigint-ish value would otherwise reach the JSON
    // boundary and throw there rather than here.
    pid: row.pid === null ? null : Number(row.pid),
    claimedAt: isoOrString(row.claimedAt),
    releasedAt: isoOrStringOrNull(row.releasedAt),
  };
}

/**
 * Buckets a page's worth of raw rows by item id, preserving each item's own
 * ordering from the query.
 *
 * Returns a `Map` rather than mutating entries in place so the caller
 * decides what an item with no assignment looks like — which is an empty
 * array, never a missing key: "nobody holds this" and "we did not look" must
 * not render identically, the same distinction #123 established for a
 * withheld board column.
 */
export function groupBoardAssignmentsByItem(
  rows: readonly RawBoardAssignmentRow[],
): Map<string, BoardAssignment[]> {
  const byItem = new Map<string, BoardAssignment[]>();
  for (const row of rows) {
    const list = byItem.get(row.itemId) ?? [];
    list.push(toBoardAssignment(row));
    byItem.set(row.itemId, list);
  }
  return byItem;
}
