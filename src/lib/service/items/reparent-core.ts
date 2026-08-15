// The shared body behind `reparent_item` and `retype_to_task` — SCHEMA.md
// §1 (`kind` derived from depth), §17.2 (`items.max_depth`), DECISIONS.md
// §13c (a project's state is derived from its children).
//
// **Why a move is a separate operation from an edit.** `kind` is derived
// from depth and stored, so changing an item's parent is not the same shape
// of change as editing its title: it moves the item *and* re-derives a
// stored field on it, and — because `kind` is derived from depth — on every
// descendant beneath it too. `update_item` diffs a fixed list of columns and
// writes each one; a parent change fans out to rows it was never given, and
// carries four refusals a column write has no place to make (a cycle, a
// missing parent, an archived area, a subtree that would exceed
// `items.max_depth`). Putting it there would make `update_item`'s "edit a
// field" contract quietly untrue for one field.
//
// **What this module deliberately does not do.** It never transitions
// anything and never touches `state`. Position and state are separate
// questions, and DECISIONS.md §13c's two guarantees — that a project has no
// state of its own, and that a parent cannot finish with an actionable child
// — both survive a move untouched, because a move changes neither an item's
// stored state nor the guard that reads its children.
import { GuardRejectedError, NotFoundError } from "../errors";
import type { ServiceContext } from "../context";
import { callerEventActor, liveAssignmentId } from "./event-attribution";
import { recordFieldChanges } from "@/lib/events";
import { kindForDepth } from "./create-core";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "./row";

/** The guard id every depth refusal on a move carries — the same setting `create-core` reads. */
export const MAX_DEPTH_GUARD = "items.max_depth";

/** The guard id a move that would make an item its own ancestor is refused with. */
export const CYCLE_GUARD = "hierarchy.no_cycle";

/** The guard id a retype of a project that still has children is refused with. */
export const RETYPE_HAS_CHILDREN_GUARD = "hierarchy.no_retype_with_children";

/** One row of the moving item's subtree, as `subtreeOf` returns it. */
interface SubtreeRow {
  id: string;
  parentId: string | null;
  kind: string;
  /** Hops from the moving item: 0 is the item itself, 1 its children, and so on. */
  relativeDepth: number;
}

/**
 * The moving item and every descendant beneath it, each with its depth
 * *relative to the moving item*.
 *
 * One recursive query answers all three questions a move has to ask: which
 * rows exist under this one (so their `kind` can be re-derived), how deep the
 * deepest of them sits (so the depth guard can be checked against the whole
 * subtree rather than only its root), and — because the moving item is row
 * zero — whether the proposed parent is among them, which is exactly the
 * cycle test.
 *
 * Asking it once rather than per-question is what keeps the three answers
 * consistent with each other: a subtree read twice inside one transaction
 * would be the same, but a subtree read once and reasoned about three times
 * cannot disagree with itself even in principle.
 */
export async function subtreeOf(ctx: ServiceContext, itemId: string): Promise<SubtreeRow[]> {
  return ctx.db.$queryRawUnsafe<SubtreeRow[]>(
    `WITH RECURSIVE subtree AS (
       SELECT "id", "parentId", "kind", 0 AS "relativeDepth"
       FROM "Item" WHERE "id" = $1
       UNION ALL
       SELECT i."id", i."parentId", i."kind", s."relativeDepth" + 1
       FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
     )
     SELECT "id", "parentId", "kind", "relativeDepth"::int AS "relativeDepth" FROM subtree`,
    itemId,
  );
}

/**
 * The absolute depth of `itemId` — 0 for a root, 1 for a task, and so on.
 *
 * Distinct from `create-core`'s `ancestorDepthOf`, which returns the ancestor
 * *row count* (1 for a root) because its callers ask "what depth would a
 * child of this land at". A move needs the item's own depth, and conflating
 * the two off-by-one is exactly the kind of drift the two names exist to
 * prevent. Returns `undefined` when no such row exists, so the caller can
 * name the field it was given.
 */
export async function depthOf(ctx: ServiceContext, itemId: string): Promise<number | undefined> {
  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `WITH RECURSIVE ancestors AS (
       SELECT "id", "parentId" FROM "Item" WHERE "id" = $1
       UNION ALL
       SELECT i."id", i."parentId"
       FROM "Item" i JOIN ancestors a ON i."id" = a."parentId"
     )
     SELECT "id" FROM ancestors`,
    itemId,
  );
  return rows.length === 0 ? undefined : rows.length - 1;
}

/** The item as a move reads it before deciding anything. */
export async function loadItem(ctx: ServiceContext, itemId: string): Promise<RawItemRow> {
  const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
    `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
    itemId,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No such item: ${itemId}.`, { fields: ["id"] });
  }
  return row;
}

/**
 * Applies a resolved move: writes the new `parentId`, re-derives `kind` on
 * the moving item and every descendant, and appends one `field_change` row
 * per field that actually changed.
 *
 * `newDepth` is the depth the moving item lands at — resolved and guarded by
 * the caller, never computed here, because the two callers resolve it from
 * different things (`reparent_item` from a named parent, `retype_to_task`
 * from the inbox it falls back to) and each has its own field to blame.
 *
 * **Events go through `recordFieldChanges`**, the single writer, once per
 * affected row. A descendant whose `kind` changes is a real change to that
 * row and is recorded on that row's own ledger — asking "why is this a task
 * now" of the item it happened to and getting an answer is the whole reason
 * the ledger is per-item. A descendant whose `kind` is unchanged (a move that
 * shifts depth by zero, or one deep enough that `kindForDepth` returns the
 * same `subtask` either side) writes nothing, because `recordFieldChanges`
 * skips fields that did not change — so a no-op move is provably a no-op in
 * the ledger rather than a burst of identical rows.
 */
export async function applyMove(
  ctx: ServiceContext,
  args: {
    readonly item: RawItemRow;
    readonly newParentId: string | null;
    readonly newDepth: number;
    readonly subtree: readonly SubtreeRow[];
  },
): Promise<ItemRecord> {
  const { item, newParentId, newDepth, subtree } = args;

  const actor = callerEventActor(ctx.caller);

  // The moving item itself: `parentId` and `kind` together, so the two
  // halves of one move land in the same statement and cannot half-apply.
  const newKind = kindForDepth(newDepth);
  const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
    `UPDATE "Item"
     SET "parentId" = $1, "kind" = $2::"ItemKind", "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $3
     RETURNING ${ITEM_COLUMNS}`,
    newParentId,
    newKind,
    item.id,
  );
  const updated = rows[0];
  if (!updated) {
    throw new NotFoundError(`No such item: ${item.id}.`, { fields: ["id"] });
  }

  await recordFieldChanges(ctx.db, {
    itemId: item.id,
    actor,
    assignmentId: await liveAssignmentId(ctx.db, item.id, ctx.caller),
    before: { parentId: item.parentId, kind: item.kind },
    after: { parentId: newParentId, kind: newKind },
    fields: ["parentId", "kind"],
  });

  // Every descendant's `kind` is re-derived from where it now sits. Skipping
  // this is the failure mode worth naming: the moved item would read
  // correctly and its children would keep a `kind` describing where they used
  // to be, which is the same stored-derived-field-gone-stale defect that
  // makes a project's state derived in the first place (DECISIONS.md §13c).
  for (const descendant of subtree) {
    if (descendant.relativeDepth === 0) continue;
    const descendantKind = kindForDepth(newDepth + descendant.relativeDepth);
    if (descendantKind === descendant.kind) continue;
    await ctx.db.$executeRawUnsafe(
      `UPDATE "Item" SET "kind" = $1::"ItemKind", "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2`,
      descendantKind,
      descendant.id,
    );
    await recordFieldChanges(ctx.db, {
      itemId: descendant.id,
      actor,
      assignmentId: await liveAssignmentId(ctx.db, descendant.id, ctx.caller),
      before: { kind: descendant.kind },
      after: { kind: descendantKind },
      fields: ["kind"],
    });
  }

  return toItemRecord(updated);
}

/**
 * Refuses a move whose subtree would not fit under `newDepth`.
 *
 * Checked against the **deepest descendant**, not the moving item, because
 * the setting is a bound on the tree rather than on one row: moving a
 * three-deep subtree one level down pushes its leaves three levels past
 * wherever its root lands, and a check that only looked at the root would let
 * exactly that through while reporting the bound was respected.
 *
 * Reads `ctx.settings.values["items.max_depth"]` rather than a constant, so
 * an installation that has widened or narrowed the bound gets the bound it
 * configured — the same value and the same guard id `create-core` refuses a
 * create with.
 */
export function assertDepthFits(
  ctx: ServiceContext,
  args: {
    readonly newDepth: number;
    readonly subtree: readonly SubtreeRow[];
    readonly field: string;
  },
): void {
  const maxDepth = ctx.settings.values["items.max_depth"];
  const deepestRelative = args.subtree.reduce(
    (deepest, row) => Math.max(deepest, row.relativeDepth),
    0,
  );
  const deepestAbsolute = args.newDepth + deepestRelative;
  if (deepestAbsolute > maxDepth) {
    throw new GuardRejectedError(
      MAX_DEPTH_GUARD,
      deepestRelative === 0
        ? `This move would put the item at depth ${deepestAbsolute}, past the configured maximum of ${maxDepth}.`
        : `This move would put the deepest item in its subtree at depth ${deepestAbsolute}, past the configured maximum of ${maxDepth}.`,
      { fields: [args.field] },
    );
  }
}

/**
 * Refuses a move that would make an item its own ancestor.
 *
 * The test is membership of the moving item's own subtree, which covers both
 * shapes at once: naming the item itself as its parent (it is row zero of its
 * own subtree) and naming any descendant of it (a longer cycle). Written as
 * one check rather than a self-check plus a descendant-check because they are
 * the same fact, and two checks could disagree.
 */
export function assertNoCycle(args: {
  readonly newParentId: string;
  readonly subtree: readonly SubtreeRow[];
  readonly field: string;
}): void {
  if (args.subtree.some((row) => row.id === args.newParentId)) {
    throw new GuardRejectedError(
      CYCLE_GUARD,
      "An item cannot be moved under itself or under one of its own descendants.",
      { fields: [args.field] },
    );
  }
}

/**
 * Resolves a named parent to its depth, refusing one that does not exist or
 * whose area is archived.
 *
 * **Archived is asked of the parent's area, because an item has no archived
 * flag of its own.** `Area` and `Repo` carry `archivedAt`; `Item` does not
 * (SCHEMA.md §1 — an item leaves circulation by reaching a terminal state,
 * not by being archived). Refusing a parent in an archived area is the honest
 * reading of "do not file new work under something that has been retired":
 * an archived area is the installation saying that work there is over, and a
 * move into it would be filing live work somewhere nobody is looking.
 *
 * A parent in a **terminal state** is deliberately *not* refused. It reads
 * like the same rule and is not: `hierarchy.no_finish_with_actionable_child`
 * already governs the relationship between a parent's completion and its
 * children, and a repair pass filing a shipped task under the project it
 * always belonged to is a legitimate move that a terminal-parent refusal
 * would block — with no other way to make the row correct.
 */
export async function resolveParent(
  ctx: ServiceContext,
  args: { readonly parentId: string; readonly field: string },
): Promise<number> {
  const rows = await ctx.db.$queryRawUnsafe<{ id: string; archivedAt: Date | null }[]>(
    `SELECT i."id", a."archivedAt"
     FROM "Item" i JOIN "Area" a ON a."id" = i."area"
     WHERE i."id" = $1`,
    args.parentId,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No such item: ${args.parentId}.`, { fields: [args.field] });
  }
  if (row.archivedAt !== null) {
    throw new NotFoundError(
      `Item ${args.parentId} is in an archived area and cannot take new children.`,
      { fields: [args.field] },
    );
  }

  const depth = await depthOf(ctx, args.parentId);
  if (depth === undefined) {
    // Unreachable in practice — the row was just read. Thrown rather than
    // asserted so a tree mutated concurrently gives the caller a refusal it
    // can read instead of a type error.
    throw new NotFoundError(`No such item: ${args.parentId}.`, { fields: [args.field] });
  }
  return depth;
}
