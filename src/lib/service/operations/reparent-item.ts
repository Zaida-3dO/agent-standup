// `reparent_item` — moves an item to a different parent, re-deriving `kind`
// and depth. SCHEMA.md §1, §17.2 (`items.max_depth`), DECISIONS.md §13c.
//
// **The gap this closes.** `parentId` was settable at create and never
// again, and `kind` is derived from parentage — so an item filed in the
// wrong place, or filed nowhere, was in the wrong place permanently. The
// sharpest form of that is an item with no parent and no children: it is a
// `project`, so the state machine refuses to transition it (a project's
// state is derived from its children), and it has no children whose
// completion could derive one. Neither route to a resolved state exists, and
// the field that would open one could not be written. This operation is that
// field becoming writable.
//
// **What it deliberately does not do.** It does not transition anything and
// never touches `state`. The two guarantees DECISIONS.md §13c rests on —
// a project has no state of its own, and a parent cannot finish while a
// child is actionable — are both untouched by a move: the first because this
// operation never asks a project to hold a state, and the second because the
// guard reads an item's children at the moment it finishes, so an item that
// gains a child by a move is subject to it immediately and one that loses a
// child stops being blocked by it. Making a *position* correctable is a
// different thing from letting a project transition, and this operation is
// only the first.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  applyMove,
  assertDepthFits,
  assertNoCycle,
  loadItem,
  resolveParent,
  subtreeOf,
} from "../items/reparent-core";
import { resolveInboxProject } from "../items/inbox-project";
import { INBOX_PROJECT_ID } from "./create-task";
import type { ItemRecord } from "../items/row";

const inputSchema = z
  .object({
    /** The item to move. */
    id: z.string().trim().min(1, "id is required"),
    /**
     * Where it moves to: an existing item's id, or the literal `"inbox"` for
     * the configured inbox project.
     *
     * `null` is a distinct, meaningful value — "make this a root", i.e. a
     * project — and is why the field is `nullable()` rather than optional. An
     * *omitted* `parentId` would read as "the caller did not say", which is
     * the ambiguity `create_task`'s sentinel exists to avoid one level up; a
     * caller of a move operation always knows where it wants the item, so the
     * field is required and its value carries the whole answer.
     */
    parentId: z.string().trim().min(1).nullable(),
  })
  .strict();

export type ReparentItemInput = z.infer<typeof inputSchema>;

export const reparentItem = defineOperation({
  name: "reparent_item",
  kind: "write",
  summary:
    'Moves an item to a different parent, re-deriving its kind and depth (and its descendants\' kinds) from where it lands. Pass parentId as an item id, the literal "inbox", or null to make it a top-level project. Refuses a cycle, a parent that does not exist or is in an archived area, and a move that would push the subtree past items.max_depth.',
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["parentId"],
        rule: "An item cannot be moved under itself or under one of its own descendants.",
      },
      {
        fields: ["parentId"],
        rule: "The deepest item in the moving subtree must still fit within items.max_depth after the move — the bound is on the whole subtree, not only the item named.",
      },
      {
        fields: ["parentId"],
        rule: "The new parent must exist and must not be in an archived area.",
      },
    ],
    example: { id: "an-item-id", parentId: "inbox" },
  },
  async handler(ctx: ServiceContext, input: ReparentItemInput): Promise<ItemRecord> {
    const item = await loadItem(ctx, input.id);

    // Read once, before anything resolves a parent, so the cycle test and
    // the depth test are asked of the same subtree.
    const subtree = await subtreeOf(ctx, input.id);

    if (input.parentId === null) {
      // Becoming a root: depth 0, kind `project`. Nothing to resolve and no
      // cycle to check — a root has no ancestors — but the depth bound still
      // applies to what hangs beneath it.
      assertDepthFits(ctx, { newDepth: 0, subtree, field: "parentId" });
      return applyMove(ctx, { item, newParentId: null, newDepth: 0, subtree });
    }

    // `"inbox"` resolves the same way `create_task` resolves it, through the
    // same function, so the sentinel means one thing in this system rather
    // than one thing per operation. Resolved *before* the cycle check, not
    // after: the inbox is an ordinary project row and could in principle be
    // a descendant of the item being moved, and checking the sentinel string
    // against a list of ids would never match.
    const parentId =
      input.parentId === INBOX_PROJECT_ID
        ? await resolveInboxProject(ctx, {
            area: item.area,
            originType: "auto",
          })
        : input.parentId;

    assertNoCycle({ newParentId: parentId, subtree, field: "parentId" });

    const parentDepth = await resolveParent(ctx, { parentId, field: "parentId" });
    const newDepth = parentDepth + 1;

    assertDepthFits(ctx, { newDepth, subtree, field: "parentId" });

    return applyMove(ctx, { item, newParentId: parentId, newDepth, subtree });
  },
});
