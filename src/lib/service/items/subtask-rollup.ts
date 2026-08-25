// How much work sits *underneath* a board card — the number a parent shows
// so its children do not have to be cards of their own.
//
// ── The problem this exists to solve ────────────────────────────────────
//
// Nesting is unbounded (SCHEMA.md §1), and until now every level of it
// competed for the same space: a task and the four subtasks under it were
// five peer cards in one column, so a column's height measured how finely
// the work had been broken down rather than how much of it there was. The
// board's answer is to show the parent only and let it *say* what is
// beneath it — which needs a count the board never had. `BoardEntry` was
// exactly `{item, column, assignments, trust}`; nothing in it could answer
// "how many, and how many are done".
//
// ── One statement for the whole page, not one per card ──────────────────
//
// The obvious implementation — read the cards, then ask each one for its
// children — is N+1 against a response that by construction contains every
// card on screen, so its cost grows with exactly the number the board
// exists to display. `get_projects` established the alternative and this
// follows its shape: seed the recursion with the direct children of *every*
// card at once (`"parentId" = ANY(...)`), then follow `parentId` down,
// carrying the **root** card's id through each level so a row three deep is
// still counted against the card it ultimately belongs to.
//
// It is the same one-statement-for-the-whole-response pass `get_board`
// already makes twice — `LIVE_BOARD_ASSIGNMENTS_SQL` for ownership and
// `NEWEST_VERIFICATION_SQL` for trust — keyed on the same array of entry
// ids, and it runs beside them for the same reason.
//
// ── Every descendant, not just direct children ──────────────────────────
//
// A card that said "2 subtasks" while hiding four more one level further
// down would be worse than saying nothing: the board's whole claim is that
// what a card hides, it accounts for. Since the default board shows level 1
// only, *everything* below a card is hidden by it, so everything below it
// is what the badge has to count. That is why this is a recursive walk and
// not a `count(*) ... GROUP BY "parentId"`, which would silently undercount
// any card whose work is organised one level deeper.
//
// ── Archived descendants count for nothing, on BOTH arms ────────────────
//
// An archived row is the installation saying it should never have existed,
// so it must not inflate a badge — and the filter has to be on **both**
// arms of the recursion, because each arm is the only one that can reach a
// different row:
//
//   - The **seed** arm covers an archived *direct child*. It is found by
//     the seed and never by the recursion, so dropping the filter there
//     counts it.
//   - The **recursive** arm covers an archived row deeper down. The
//     smallest case is an archived **grandchild under a live child**, which
//     the seed never sees, so dropping the filter there counts it no matter
//     what the seed does.
//
// An archived *mid* node needs no separate argument: the seed filter
// excludes it, and excluding it from the seed also stops the recursion
// descending through it, so its whole subtree drops with it. That is
// precisely why the grandchild-under-a-live-child case is the one that pins
// the recursive arm — the recursion has to actually run through a *live*
// parent for that filter to be the thing doing the work.
//
// This is not a hypothetical pairing. `get_projects` had to be corrected
// twice for it one level up, and a later review found the second fix was
// true in code but only half-tested, because the fixture was two levels
// deep and so could not reach the recursive arm at all. Both arms are
// therefore covered by their own named case over a **three-level** fixture
// in tests/board-subtask-rollup.test.ts; see that file's header.
import { NOT_ARCHIVED_CONDITION } from "./row";
import { STATES_BY_COLUMN } from "../board/columns";

/**
 * What one card says about the work beneath it.
 *
 * `null` on a `BoardEntry` means "this card has no descendants at all" —
 * see `subtaskRollupsFor`, which returns no row for a childless card, and
 * `BoardEntry.subtasks` for why absence is modelled rather than a zero.
 */
export interface SubtaskRollup {
  /** Every descendant at any depth, archived ones excluded. Always at least 1 — a card with none has no rollup. */
  readonly total: number;
  /**
   * Descendants in a terminal state — the `completed` column's four
   * (`merged`, `research_done`, `wont_do`, `cancelled`).
   *
   * **"Done" here means finished, not merged**, which is the honest reading
   * for a progress badge: a subtask that was cancelled is not outstanding
   * work, and a parent whose remaining children were all cancelled has
   * nothing left under it. Counting only `merged` would leave such a card
   * reading "3 subtasks · 1 done" forever with nothing anyone could do
   * about it. The four are read from `STATES_BY_COLUMN.completed` rather
   * than written out, so a thirteenth state added to the completed column
   * cannot be silently omitted here.
   */
  readonly done: number;
}

/** The raw aggregate row — one per card that has descendants, counts arriving as `bigint`. */
export interface RawSubtaskRollupRow {
  rootId: string;
  total: bigint | number | string;
  done: bigint | number | string;
}

/**
 * Postgres returns `count(*)` as `bigint`, which the driver hands back as a
 * JS `BigInt` — a value `JSON.stringify` throws on outright rather than
 * silently truncating. Both counts cross a JSON boundary, so each is
 * narrowed before it can reach a response.
 */
function toCount(value: bigint | number | string): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * The terminal states, interpolated as a SQL array literal.
 *
 * Built from `STATES_BY_COLUMN.completed` rather than written out, for the
 * reason that module gives for deriving them there: the completed column
 * and "work that is finished" are the same idea, and a second hand-written
 * list is what a future state addition updates one of and not the other.
 *
 * Interpolating into SQL is safe **only** because these values come from
 * that module-level constant and never from input; there is no path from a
 * caller to this string.
 */
const DONE_STATES_SQL = STATES_BY_COLUMN.completed
  .map((state) => `'${state}'::"ItemState"`)
  .join(", ");

/**
 * Counts every card's descendants in **one** recursive statement.
 *
 * `$1` is the array of card ids. Returns one row per card that has at least
 * one live descendant — a card with none is simply absent, which is what
 * lets `null` mean "nothing underneath" without a second query to tell the
 * two apart.
 *
 * The archive predicate appears on both arms; see the module header for why
 * each one is load-bearing on its own.
 */
export const SUBTASK_ROLLUP_SQL = `WITH RECURSIVE subtree AS (
     SELECT i."id", i."state", i."parentId" AS "rootId"
     FROM "Item" i
     WHERE i."parentId" = ANY($1::text[]) AND i.${NOT_ARCHIVED_CONDITION}
     UNION ALL
     SELECT i."id", i."state", s."rootId"
     FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
     WHERE i.${NOT_ARCHIVED_CONDITION}
   )
   SELECT s."rootId" AS "rootId",
     count(*)::bigint AS "total",
     count(*) FILTER (WHERE s."state" IN (${DONE_STATES_SQL}))::bigint AS "done"
   FROM subtree s
   GROUP BY s."rootId"`;

/**
 * Groups the raw rows by card id.
 *
 * A `Map` rather than a keyed object so a card id can never collide with an
 * inherited property name, the same shape `groupBoardAssignmentsByItem`
 * returns for the pass this runs beside.
 */
export function groupSubtaskRollupsByItem(
  rows: readonly RawSubtaskRollupRow[],
): Map<string, SubtaskRollup> {
  const byItem = new Map<string, SubtaskRollup>();
  for (const row of rows) {
    byItem.set(row.rootId, { total: toCount(row.total), done: toCount(row.done) });
  }
  return byItem;
}
