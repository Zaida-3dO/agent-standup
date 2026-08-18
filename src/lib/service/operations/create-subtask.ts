// `create_subtask` — SCHEMA.md §1, §17.2 (`items.max_depth`).
//
// **Why its own operation rather than an optional parent on `create_task`.**
// The alternative — `create_task` taking an optional task-parent alongside
// its required project — would mean the kind you get again depends on which
// optional field you happened to fill in. That is precisely the shape this
// change exists to remove, reintroduced one level down: a caller could ask
// for a task, fill the wrong field, and hold a subtask. Three kinds, three
// operations, each naming its own parent, means the kind is a property of
// the call rather than of the arguments.
//
// It also keeps each schema honest about its own parent. A subtask's parent
// is a *task*, so this takes `taskId`; a combined operation would have to
// take both fields and enforce "exactly one of" in a refinement — a rule
// that reads fine in code and reads, in a tool list, as two optional fields
// with an invisible constraint between them.
//
// **Depth is not fixed at 2.** SCHEMA.md §1: "`subtask` (depth ≥ 2 —
// nesting is unbounded, so everything deeper is still a subtask)". So this
// accepts any parent that is not a root, and the only ceiling is
// `items.max_depth`, enforced in the shared insert.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ancestorDepthOf,
  commonCreateShape,
  insertItem,
  areaSpellingCheck,
  areaSpellingMessage,
  originPersonCheck,
  originPersonMessage,
  type CommonCreateInput,
} from "../items/create-core";
import type { ItemRecord } from "../items/row";

const inputSchema = z
  .object({
    ...commonCreateShape,
    /**
     * An existing `items.id` that is not a project — a task, or a subtask
     * when nesting deeper. Required: a subtask is defined by having one.
     */
    taskId: z.string().trim().min(1, "taskId is required"),
  })
  .strict()
  .refine(originPersonCheck, originPersonMessage)
  .refine(areaSpellingCheck, areaSpellingMessage);

export type CreateSubtaskInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const createSubtask = defineOperation({
  name: "create_subtask",
  kind: "write",
  summary:
    "Creates a subtask under a task. taskId is required and must name a task or a deeper subtask, never a project. A subtask has its own state and can be transitioned.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateSubtaskInput): Promise<ItemRecord> {
    const { taskId, ...common } = input;

    const depth = await ancestorDepthOf(ctx, taskId);
    if (depth === undefined) {
      throw new NotFoundError(`No such task: ${taskId}.`, { fields: ["taskId"] });
    }
    // Depth 1 means `taskId` names a root — a project. Refused rather than
    // creating a task, for the same reason `create_task` refuses a task
    // parent: the caller named the kind in the operation it chose, and
    // silently giving it a different one is the defect, not the courtesy.
    if (depth === 1) {
      throw new NotFoundError(
        `Item ${taskId} is a project, not a task. Use create_task to put work directly under a project.`,
        { fields: ["taskId"] },
      );
    }

    return insertItem(ctx, common as CommonCreateInput, { id: taskId, depth });
  },
});
