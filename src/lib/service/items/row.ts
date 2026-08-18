// Shared shape for the item operations — the row as `items` returns it, and
// the mapping from a raw Postgres row to it. See docs/plans/SCHEMA.md §1.
//
// Operations run against `TransactionHandle` (`../../context.ts`), which
// exposes only `$queryRawUnsafe`/`$executeRawUnsafe` — no Prisma model API.
// That is deliberate (`context.ts`: "an operation that cannot import the
// database client cannot bypass the transaction"), so every read here maps
// columns by hand rather than trusting a generated client's typing.

/**
 * The longest a headline may be — MILESTONES.md #107.
 *
 * A cap rather than a convention, because a headline is the one field the
 * slim read *always* returns: the whole point of that read is that its size
 * is knowable in advance, and an uncapped headline would put an unbounded
 * string straight back into the response that exists to be bounded. 200
 * characters is comfortably a sentence and comfortably not a brief, so the
 * refusal only ever fires on something that was going to be a paragraph.
 *
 * Enforced in the operations' input schemas rather than as a database
 * constraint: a validator refuses with `invalid_input` and the offending
 * field path, which is a usable answer, where a column-length violation
 * surfaces as a driver error nobody can act on.
 */
export const HEADLINE_MAX_CHARS = 200;

/** One `items` row, as every item operation reads and returns it. */
export interface ItemRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: "project" | "task" | "subtask";
  readonly title: string;
  /** The one-line BLUF — see `ItemSummaryRecord`. Null on an item nobody has written one for. */
  readonly headline: string | null;
  readonly body: string;
  readonly state: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly originType: "person" | "source" | "auto";
  readonly originPersonId: string | null;
  /** The item's PRIMARY area — `areas[0]`, kept as its own column (SCHEMA.md §23.1). */
  readonly area: string;
  /** Every area this item belongs to, primary first (SCHEMA.md §23.1). Never empty. */
  readonly areas: readonly string[];
  readonly repo: string | null;
  readonly branch: string | null;
  readonly needsVisualReview: boolean;
  readonly driveMode: "autonomous" | "supervised" | "manual";
  readonly mergeAuthority: "pre_approved" | "needs_approval" | "agent_judgement";
  readonly blockedReason: string | null;
  readonly blockedOnType: "person" | "external_process" | "time" | null;
  readonly blockedOnPersonId: string | null;
  readonly unblockAt: string | null;
  readonly pauseReason: string | null;
  readonly resumeCondition: string | null;
  readonly resumeAttempts: number;
  readonly difficulty: unknown;
  readonly sourceRef: string | null;
  readonly notify: unknown;
  readonly estimatedCost: string | null;
  readonly customFields: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  /**
   * When this item was withdrawn from circulation (MILESTONES.md #137).
   * Null on everything a list-shaped read returns, because those reads
   * filter archived rows out — so a non-null value here is only ever seen by
   * a caller holding the id of a specific item, which is the one way an
   * archived row is reachable.
   */
  readonly archivedAt: string | null;
  /** Why it was archived. Non-null exactly when `archivedAt` is. */
  readonly archivedReason: string | null;
  /** The item this one was archived in favour of, where one was named. */
  readonly supersededById: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Item"` row — driver values, not yet an `ItemRecord`. */
export interface RawItemRow {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  headline: string | null;
  body: string;
  state: string;
  priority: string;
  originType: string;
  originPersonId: string | null;
  area: string;
  areas: string[] | null;
  repo: string | null;
  branch: string | null;
  needsVisualReview: boolean;
  driveMode: string;
  mergeAuthority: string;
  blockedReason: string | null;
  blockedOnType: string | null;
  blockedOnPersonId: string | null;
  unblockAt: Date | string | null;
  pauseReason: string | null;
  resumeCondition: string | null;
  resumeAttempts: number;
  difficulty: unknown;
  sourceRef: string | null;
  notify: unknown;
  estimatedCost: unknown;
  customFields: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
  archivedAt: Date | string | null;
  archivedReason: string | null;
  supersededById: string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Maps one raw driver row to the typed shape every item operation returns.
 *
 * A single function so `create_item`, `get_item`, `update_item` and
 * `list_items` read a row identically — if the mapping were duplicated
 * per-operation, one of the four could drift and the conformance harness
 * (§22) would see a create response shaped differently from a get response
 * for the same row, which is exactly the kind of adapter-invisible drift
 * this whole layer exists to rule out.
 */
export function toItemRecord(row: RawItemRow): ItemRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind as ItemRecord["kind"],
    title: row.title,
    headline: row.headline,
    body: row.body,
    state: row.state,
    priority: row.priority as ItemRecord["priority"],
    originType: row.originType as ItemRecord["originType"],
    originPersonId: row.originPersonId,
    area: row.area,
    // Non-empty for every row, including one whose join rows do not exist —
    // a row written before `ItemArea` did, or one inserted directly. Both
    // are real: `array_agg` returns SQL NULL rather than an empty array when
    // its subquery matches nothing.
    //
    // **The `COALESCE` in `ITEM_COLUMNS` is what actually supplies the
    // fallback**, because it runs in the same query that reads the row. This
    // `??` is the type-level backstop for it: `RawItemRow.areas` is nullable
    // (a raw driver row is whatever the caller's SQL selected, and not every
    // query in the codebase has to use `ITEM_COLUMNS`), so narrowing it here
    // is what lets `ItemRecord.areas` be a plain non-null array rather than
    // pushing the null onto every consumer. Removing either one alone leaves
    // the behaviour correct; removing both hands callers a null — which is
    // why `tests/item-areas.test.ts` asserts the outcome rather than
    // either mechanism.
    areas: row.areas ?? [row.area],
    repo: row.repo,
    branch: row.branch,
    needsVisualReview: row.needsVisualReview,
    driveMode: row.driveMode as ItemRecord["driveMode"],
    mergeAuthority: row.mergeAuthority as ItemRecord["mergeAuthority"],
    blockedReason: row.blockedReason,
    blockedOnType: row.blockedOnType as ItemRecord["blockedOnType"],
    blockedOnPersonId: row.blockedOnPersonId,
    unblockAt: isoOrNull(row.unblockAt),
    pauseReason: row.pauseReason,
    resumeCondition: row.resumeCondition,
    resumeAttempts: row.resumeAttempts,
    difficulty: row.difficulty,
    sourceRef: row.sourceRef,
    notify: row.notify,
    // Prisma's raw driver returns NUMERIC as a string already; `String()`
    // is only a safety net if a future driver upgrade starts returning it
    // some other JS type.
    estimatedCost: row.estimatedCost === null ? null : String(row.estimatedCost),
    customFields: row.customFields,
    createdAt: isoOrNull(row.createdAt) as string,
    updatedAt: isoOrNull(row.updatedAt) as string,
    completedAt: isoOrNull(row.completedAt),
    archivedAt: isoOrNull(row.archivedAt),
    archivedReason: row.archivedReason,
    supersededById: row.supersededById,
  };
}

/**
 * The slim shape every item read returns unless the caller asks for more —
 * MILESTONES.md #107.
 *
 * **Why the default is this and not the whole row.** `ITEM_COLUMNS` below is
 * one hardcoded thirty-column `SELECT` shared by `get_item`, `list_items`
 * and `get_board`, and `toItemRecord` maps every column unconditionally, so
 * `body` and `customFields` came back on every call from every surface.
 * Measured on a live store: one `get_item` at 145,317 characters, of which
 * `customFields` was 94,038 and `body` 49,538 — the handful of scalars the
 * caller actually wanted were 0.2% of what it paid for.
 *
 * **Neither a filter nor a page size reaches that.** `limit` bounds row
 * *count*; nothing bounds row *size*, so `limit: 1` on the largest item
 * still overflows a context window, and `get_item` is `WHERE id = $1` with
 * no filter to default at all. The only control that works is choosing
 * which columns come back.
 *
 * **`headline` is why the slim shape is useful rather than merely small.**
 * `{id, title, state}` alone answers "which item" but not "what is it" —
 * that answer lived only in a body running to kilobytes. A one-line BLUF,
 * written at mint and maintained as the work moves, is what makes the cheap
 * read the *sufficient* read for the question a session actually asks. A
 * projection nobody knows the shape of would only move the discoverability
 * problem; a named field with a stated meaning does not.
 *
 * The shape follows in-tree precedent rather than inventing one:
 * `orientation` already selects `id, title, state` for its child lists and
 * reserves the full record for the one focal item.
 */
export interface ItemSummaryRecord {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** Null when nobody has written one — deliberately not defaulted to the title, so a caller can tell. */
  readonly headline: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one summary row. */
export interface RawItemSummaryRow {
  id: string;
  title: string;
  state: string;
  headline: string | null;
}

/**
 * The board's slim entry — `ItemSummaryRecord` plus the seven fields a card
 * renders and the board cannot derive without.
 *
 * **Why this is wider than `ItemSummaryRecord` rather than reusing it.**
 * `get_board` is not a list of ids; it is a rendering, and it has two
 * non-negotiable extra needs. `kind` is structural — a project's column is
 * computed from its subtree rather than read off its own state
 * (DECISIONS.md §13c), so dropping `kind` would silently put every project
 * in the wrong column. The remaining six are what a card shows: priority,
 * area and repo as the card's metadata line, and the blocked/paused fields
 * as the one-line reason a Waiting card gives for being there.
 *
 * **What it still leaves behind is the entire point.** `body` and
 * `customFields` were 99% of the measured payload and no card renders
 * either. Slimming the board to what it draws is what turns a board read
 * from a page-sized response into a card-sized one, and adding a seventh
 * field a card genuinely renders would not undo that; adding `body` would.
 */
export interface BoardItemSummaryRecord extends ItemSummaryRecord {
  readonly kind: "project" | "task" | "subtask";
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly area: string;
  readonly repo: string | null;
  readonly blockedReason: string | null;
  readonly blockedOnType: "person" | "external_process" | "time" | null;
  readonly blockedOnPersonId: string | null;
  readonly pauseReason: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one board summary row. */
export interface RawBoardItemSummaryRow extends RawItemSummaryRow {
  kind: string;
  priority: string;
  area: string;
  repo: string | null;
  blockedReason: string | null;
  blockedOnType: string | null;
  blockedOnPersonId: string | null;
  pauseReason: string | null;
}

/** Maps one raw board summary row to `BoardItemSummaryRecord`. */
export function toBoardItemSummaryRecord(row: RawBoardItemSummaryRow): BoardItemSummaryRecord {
  return {
    ...toItemSummaryRecord(row),
    kind: row.kind as BoardItemSummaryRecord["kind"],
    priority: row.priority as BoardItemSummaryRecord["priority"],
    area: row.area,
    repo: row.repo,
    blockedReason: row.blockedReason,
    blockedOnType: row.blockedOnType as BoardItemSummaryRecord["blockedOnType"],
    blockedOnPersonId: row.blockedOnPersonId,
    pauseReason: row.pauseReason,
  };
}

/** Maps one raw summary row to `ItemSummaryRecord` — the slim counterpart of `toItemRecord`. */
export function toItemSummaryRecord(row: RawItemSummaryRow): ItemSummaryRecord {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    headline: row.headline,
  };
}

/**
 * The four columns the slim read selects.
 *
 * A separate constant rather than a subset computed from `ITEM_COLUMNS`:
 * that string is pre-joined and carries its own quoting, so deriving from it
 * would mean parsing it. Two short lists that a test compares are cheaper
 * to keep honest than one list that has to be taken apart.
 */
export const ITEM_SUMMARY_COLUMNS = ["id", "title", "state", "headline"].join(", ");

/** The columns the board's slim read selects — `ITEM_SUMMARY_COLUMNS` plus what a card draws. */
export const BOARD_ITEM_SUMMARY_COLUMNS = [
  ITEM_SUMMARY_COLUMNS,
  "kind",
  "priority",
  "area",
  "repo",
  '"blockedReason"',
  '"blockedOnType"',
  '"blockedOnPersonId"',
  '"pauseReason"',
].join(", ");

export const ITEM_COLUMNS = [
  "id",
  '"parentId"',
  "kind",
  "title",
  "headline",
  "body",
  "state",
  "priority",
  '"originType"',
  '"originPersonId"',
  "area",
  // Every area, primary first. A correlated subquery rather than a join,
  // because every caller of ITEM_COLUMNS selects whole rows and a join would
  // multiply them by the number of areas — the aggregate has to happen
  // before the row is returned, not after.
  '(SELECT COALESCE(array_agg("areaId" ORDER BY ("areaId" <> "Item"."area"), "areaId"), ARRAY["Item"."area"]) FROM "ItemArea" WHERE "itemId" = "Item"."id") AS "areas"',
  "repo",
  "branch",
  '"needsVisualReview"',
  '"driveMode"',
  '"mergeAuthority"',
  '"blockedReason"',
  '"blockedOnType"',
  '"blockedOnPersonId"',
  '"unblockAt"',
  '"pauseReason"',
  '"resumeCondition"',
  '"resumeAttempts"',
  "difficulty",
  '"sourceRef"',
  "notify",
  '"estimatedCost"',
  '"customFields"',
  '"createdAt"',
  '"updatedAt"',
  '"completedAt"',
  '"archivedAt"',
  '"archivedReason"',
  '"supersededById"',
].join(", ");

/**
 * The condition every ordinary item read adds so archived rows are not
 * served (MILESTONES.md #137).
 *
 * A shared constant rather than the string written at each site, for one
 * reason worth stating: there is no single funnel every item read passes
 * through — each operation builds its own `WHERE` — so the guarantee "an
 * archived item is served by no ordinary read" is held by a *set* of call
 * sites agreeing with each other. A constant makes that set greppable and
 * gives `tests/item-archive.test.ts` one symbol to assert every read uses,
 * which is what turns the agreement from a convention into something a test
 * can check.
 *
 * Deliberately parameterless. Every peer condition in these queries takes a
 * `$n` placeholder and threads `paramIndex`; this one takes none, so it can
 * be pushed into a condition list at any position without disturbing the
 * placeholder numbering the surrounding code is counting on.
 */
export const NOT_ARCHIVED_CONDITION = '"archivedAt" IS NULL';

/**
 * Which column list a read should select, given the caller's `full` flag.
 *
 * A named function rather than a ternary at each call site, and it exists
 * for a reason worth stating: `toItemSummaryRecord` strips the heavy fields
 * out of the response object regardless of what the query fetched, so a read
 * that selected all thirty columns and then mapped four would return a
 * byte-identical response while doing the exact work this row exists to
 * stop. That defect is invisible to any assertion about the response — the
 * only way to catch it is to test the column choice itself, which means it
 * has to be a thing that can be called.
 */
export function itemColumnsFor(full: boolean, variant: "item" | "board" = "item"): string {
  if (full) return ITEM_COLUMNS;
  return variant === "board" ? BOARD_ITEM_SUMMARY_COLUMNS : ITEM_SUMMARY_COLUMNS;
}
