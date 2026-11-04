// `create_task` — SCHEMA.md §1, §17.2 (`items.inbox_project`).
//
// A task is depth 1: a child of a project, with a state of its own that the
// state machine will move. `projectId` is **required**, and it is called
// `projectId` rather than `parentId` on purpose — the field a caller fills
// in should be the question it can actually answer ("which project is this
// under?"), not the mechanism that answers it ("what row does the parent
// pointer point at?"). Naming the mechanism is what let a caller ask for a
// task, omit the pointer, and receive a project.
//
// **The Inbox takes no new work.** It keeps the items already in it as
// history and is hidden once nothing in it is open; a task filed there is
// one nobody triaged. So the literal `"inbox"` and the id of the Inbox
// project are both refused here, before anything is read or written, and
// every caller inherits that — `create_work` delegates to this handler, and
// the HTTP route and the command line call it directly. The refusal names
// the one command that fixes the call (`project list`).
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ancestorDepthOf,
  COMMON_CREATE_RULES,
  COMMON_CREATE_CONDITIONALLY_REQUIRED,
  commonCreateShape,
  insertItem,
  areaSpellingCheck,
  areaSpellingMessage,
  originPersonCheck,
  originPersonMessage,
  toCreatedWriteRecord,
  type CommonCreateInput,
  type CreatedItem,
  type CreatedWriteRecord,
  TITLE_CONVENTION_CONTRACT_RULE,
} from "../items/create-core";

/**
 * The shortcut literal that names the Inbox where a project id goes.
 *
 * A named constant because it is the thing that is refused here, and
 * because the other operations that take a project pointer (`reparent_item`,
 * `retype_to_task`, `repair_stuck_projects`) compare against it.
 */
export const INBOX_PROJECT_ID = "inbox";

/**
 * What a caller is told when work is aimed at the Inbox.
 *
 * Inbox is not a place for work: it keeps its finished items as history and
 * is hidden once nothing in it is open. New work names a real project, so the
 * board never grows a pile of tasks nobody triaged. Worded for the person
 * reading it, and names the one command that fixes the call.
 */
export const INBOX_REFUSAL_MESSAGE =
  "The Inbox does not take new work, so nothing was created. Name the project this task belongs under: " +
  "run `project list` to see the projects, then resend with `projectId` set to that project's id.";

/**
 * Refuses a `projectId` that is the `"inbox"` shortcut, or is the id of the
 * project the `items.inbox_project` setting names (a root with that title
 * that is not archived).
 *
 * The id check is a read, so an unknown id falls through to the ordinary
 * "no such project" answer from the caller that owns it.
 */
export async function assertNotInboxProject(
  ctx: ServiceContext,
  projectId: string,
  message: string = INBOX_REFUSAL_MESSAGE,
): Promise<void> {
  if (projectId === INBOX_PROJECT_ID) {
    throw new InvalidInputError(message, { fields: ["projectId"] });
  }
  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Item"
     WHERE "id" = $1 AND "parentId" IS NULL AND "title" = $2 AND "archivedAt" IS NULL`,
    projectId,
    ctx.settings.values["items.inbox_project"],
  );
  if (rows.length > 0) {
    throw new InvalidInputError(message, { fields: ["projectId"] });
  }
}

const inputSchema = z
  .object({
    ...commonCreateShape,
    /**
     * An existing `items.id` whose kind is `project`, and not the Inbox.
     * Required — a task belongs to a project, and the Inbox takes no new work.
     */
    projectId: z.string().trim().min(1, "projectId is required"),
  })
  .strict()
  .refine(originPersonCheck, originPersonMessage)
  .refine(areaSpellingCheck, areaSpellingMessage);

export type CreateTaskInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const createTask = defineOperation({
  name: "create_task",
  kind: "write",
  summary:
    "Creates a task under a project. projectId is required: pass a real project's id (list projects with project list). The Inbox takes no new work, so the literal \"inbox\" and the Inbox project's id are refused. A task has its own state and can be transitioned.",
  contract: {
    // The title convention (MILESTONES.md #131). Declared here so a
    // caller reaches it the moment it is refused on any other field —
    // `runtime.ts` appends a `describe_tool` pointer to every
    // `invalid_input` refusal — and so `describe_tool` can state it on
    // demand rather than it being charged to every turn in `summary`.
    rules: [TITLE_CONVENTION_CONTRACT_RULE, ...COMMON_CREATE_RULES],
    conditionallyRequired: COMMON_CREATE_CONDITIONALLY_REQUIRED,
    example: {
      title: "Let people reset a forgotten password",
      body: "The reset link expires too fast.",
      area: "web",
      originType: "auto",
      projectId: "<a project id from a project listing>",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: CreateTaskInput,
  ): Promise<CreatedItem | CreatedWriteRecord> {
    const { projectId, ...common } = input;

    await assertNotInboxProject(ctx, projectId);

    const depth = await ancestorDepthOf(ctx, projectId);
    if (depth === undefined) {
      throw new NotFoundError(`No such project: ${projectId}.`, { fields: ["projectId"] });
    }
    // A parent at any depth but 0 is not a project. Refused rather than
    // quietly creating a subtask, because a caller that asked for a task and
    // received a subtask is in the same position `create_item` left it in —
    // holding an item whose kind it did not choose.
    if (depth !== 1) {
      throw new NotFoundError(
        `Item ${projectId} is not a project — it is a ${depth === 2 ? "task" : "subtask"}. Use create_subtask to put work under a task.`,
        { fields: ["projectId"] },
      );
    }

    const created = await insertItem(ctx, common as CommonCreateInput, { id: projectId, depth });
    return input.full ? created : toCreatedWriteRecord(created);
  },
});
