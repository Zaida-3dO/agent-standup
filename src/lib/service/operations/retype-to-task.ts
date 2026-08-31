// `retype_to_task` — turns a childless project into a task under a named
// project, so it has a state the state machine will move. SCHEMA.md §1,
// DECISIONS.md §13c.
//
// **This is a reparent with a narrower question and a better refusal.**
// Mechanically it is `reparent_item` with a non-null parent, and it shares
// every line of the move through `reparent-core`. What it adds is the one
// check that makes the caller's actual intent stateable: it refuses an item
// that is not a project, and it refuses a project that still has children.
// A caller holding a stuck row knows the thing it wants — "this is a task,
// not a project" — and asking it to phrase that as a parent pointer is the
// same mismatch `create_task` exists to remove one level up.
//
// ── What the retyped item's state becomes, and why that is honest ────────
//
// **It keeps the state already stored on its row.** Nothing is invented and
// nothing is derived.
//
// The reason that is honest rather than convenient is that a project's state
// is derived *on read*, from its children — it is not stored as a derived
// value anywhere. `items.state` is a real column with a real value on every
// row, written at create (`on_deck`) and moved only by the state machine;
// what DECISIONS.md §13c says is that for a project **nothing reads it**
// (`board/columns.ts` derives a project's column from its descendants and
// never consults the row's own state). So a project's stored state is not a
// stale derivation that would have to be reconciled — it is a value that has
// simply been ignored for as long as the row was a project, and retyping is
// exactly the moment it starts being read again.
//
// The alternative — resetting to `on_deck` — was considered and rejected. It
// would overwrite a real value with a guess, and it would be wrong in the
// case this operation exists for: a childless project that represents work
// already finished has a stored state that says so, and stamping `on_deck`
// on it would reopen work that is done. Keeping the stored value means a
// retyped row reads as whatever it honestly was, and the caller transitions
// it from there.
//
// ── Projects that still have children ───────────────────────────────────
//
// **Refused.** A project with children is a container that is doing its job,
// and there is no answer to "what happens to the children" that is not a
// second decision smuggled into this one. Reparenting them to the grandparent
// changes their meaning; carrying them along makes them subtasks of what was
// their project, silently deepening every one of them; leaving them where
// they are is not available, because they would then hang off a task and
// their own `kind` would be wrong. Each is defensible and none is implied by
// "this should have been a task", so the operation refuses and says which
// children are in the way. A caller that genuinely wants one of those
// outcomes can have it in two explicit calls: `reparent_item` the children
// where it wants them, then retype the now-childless project. That is more
// typing and it is a decision made on the record rather than by a default.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  RETYPE_HAS_CHILDREN_GUARD,
  applyMove,
  assertDepthFits,
  assertNoCycle,
  loadItem,
  resolveParent,
  subtreeOf,
} from "../items/reparent-core";
import { resolveInboxProject } from "../items/inbox-project";
import { INBOX_PROJECT_ID } from "./create-task";
import { toItemWriteRecord, type ItemRecord, type ItemWriteRecord } from "../items/row";
import { resolveItemId } from "../items/resolve-id";

const inputSchema = z
  .object({
    /** The childless project to retype. */
    id: z.string().trim().min(1, "id is required"),
    /**
     * The project it becomes a task under — an item id, or the literal
     * `"inbox"`. Required for the reason `create_task` requires it: a task
     * belongs to a project, and a caller that has just said "this is a task"
     * is the caller best placed to say which one.
     */
    projectId: z.string().trim().min(1, "projectId is required"),
    /**
     * Return the whole `items` row rather than the slim default — the same
     * flag the reads and the other writes take (MILESTONES.md #107). Off by
     * default.
     *
     * A retype changes `kind` and `parentId` and deliberately leaves
     * `state` alone, so what a caller needs back is confirmation the right
     * row moved — not the brief it already holds. Measured at 40,780
     * characters before this flag existed, for an item with a
     * 20,000-character `body` and an equally large `customFields`.
     */
    full: z.boolean().default(false),
  })
  .strict();

export type RetypeToTaskInput = z.infer<typeof inputSchema>;

interface ChildRow {
  id: string;
  title: string;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const retypeToTask = defineOperation({
  name: "retype_to_task",
  kind: "write",
  summary:
    'Turns a childless project into a task under a project, so it has a state that can be transitioned. Pass projectId as a project id or the literal "inbox". The item keeps the state already on its row — nothing is invented. Refuses an item that is not a project, and refuses a project that still has children.',
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["id"],
        rule: "The item must be a project. A task or subtask already has a state of its own; use reparent_item to move one.",
      },
      {
        fields: ["id"],
        rule: "The project must have no children. Move them with reparent_item first, so where they end up is a decision on the record rather than a default.",
      },
      {
        fields: ["projectId"],
        rule: "The new parent must exist, must not be in an archived area, and must not be the item itself.",
      },
    ],
    example: { id: "a-stuck-project-id", projectId: "inbox" },
  },
  async handler(
    ctx: ServiceContext,
    input: RetypeToTaskInput,
  ): Promise<ItemRecord | ItemWriteRecord> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      id: await resolveItemId(ctx.db, input.id, "id"),
    };

    const item = await loadItem(ctx, input.id);

    if (item.kind !== "project") {
      throw new NotFoundError(
        `Item ${input.id} is a ${item.kind}, not a project — it already has a state of its own. Use reparent_item to move it.`,
        { fields: ["id"] },
      );
    }

    const children = await ctx.db.$queryRawUnsafe<ChildRow[]>(
      `SELECT "id", "title" FROM "Item" WHERE "parentId" = $1 ORDER BY "createdAt" ASC, "id" ASC`,
      input.id,
    );
    if (children.length > 0) {
      throw new GuardRejectedError(
        RETYPE_HAS_CHILDREN_GUARD,
        `This project still has ${children.length} ${children.length === 1 ? "child" : "children"}. ` +
          "Move them with reparent_item first — where they should end up is a decision this " +
          "operation will not make for you.",
        { fields: ["id"], details: { children: children.map((child) => child.id) } },
      );
    }

    // Childless, so its subtree is one row: itself. Read through the same
    // function anyway rather than fabricating the single row, so the cycle
    // and depth checks below run on the same shape they do for a move.
    const subtree = await subtreeOf(ctx, input.id);

    const parentId =
      input.projectId === INBOX_PROJECT_ID
        ? await resolveInboxProject(ctx, { area: item.area, originType: "auto" })
        : input.projectId;

    // Reachable only when a caller names the item itself. It has no
    // descendants — the check above proved that — so this is the self-move
    // half of the cycle rule, and it is checked with the same function so
    // there is one answer to "is this a cycle" rather than two.
    assertNoCycle({ newParentId: parentId, subtree, field: "projectId" });

    const parentDepth = await resolveParent(ctx, { parentId, field: "projectId" });
    const newDepth = parentDepth + 1;

    assertDepthFits(ctx, { newDepth, subtree, field: "projectId" });

    const moved = await applyMove(ctx, { item, newParentId: parentId, newDepth, subtree });
    // Narrowed here rather than in `reparent-core`, which `repair_stuck_projects`
    // also calls: the core keeps returning the whole row and each operation
    // decides what its own contract hands back.
    return input.full ? moved : toItemWriteRecord(moved);
  },
});
