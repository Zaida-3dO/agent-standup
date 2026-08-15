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
// **Required, with one named escape hatch.** Requiring the field is what
// makes "a task always belongs somewhere" true, and what makes the kind
// knowable from the call rather than from the database. The cost is quick
// capture: with nothing but a strict requirement, a thought you want to
// write down in one call needs a project created first, and its id looked
// up. `INBOX_PROJECT_ID` is the resolution — the literal `"inbox"`, accepted
// where a project id goes, resolving to the project named by the
// `items.inbox_project` setting and creating it on first use.
//
// The distinction from an *optional* `projectId` that silently falls back is
// the whole reason it is a sentinel and not an omission. An omitted field
// that quietly decides where the work lands is the same defect this
// operation exists to remove, one level down: the caller would again not be
// stating what it wants, and would again discover the answer later. Writing
// `"inbox"` is a caller saying "file this in the inbox" — a decision on the
// record, visible in the call, and refusable by nothing because it is always
// resolvable.
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
import { resolveInboxProject } from "../items/inbox-project";
import type { ItemRecord } from "../items/row";

/**
 * The literal a caller writes in `projectId` to mean "the inbox".
 *
 * Lowercase and unqualified, because it has to be typeable from a command
 * line without quoting rules. It cannot collide with a real project: ids are
 * generated as UUIDs, and an imported id that happened to be this string
 * would be shadowed — a real, if vanishingly unlikely, cost, stated here
 * rather than discovered. The alternative sentinels considered (a `null`, an
 * empty string, an omitted field) all read as "the caller did not say",
 * which is exactly the state this operation refuses to have.
 */
export const INBOX_PROJECT_ID = "inbox";

const inputSchema = z
  .object({
    ...commonCreateShape,
    /**
     * An existing `items.id` whose kind is `project`, or the literal
     * `"inbox"`. Required — a task belongs to a project.
     */
    projectId: z.string().trim().min(1, "projectId is required"),
  })
  .strict()
  .refine(originPersonCheck, originPersonMessage)
  .refine(areaSpellingCheck, areaSpellingMessage);

export type CreateTaskInput = z.infer<typeof inputSchema>;

export const createTask = defineOperation({
  name: "create_task",
  kind: "write",
  summary:
    'Creates a task under a project. projectId is required — pass a project\'s id, or the literal "inbox" to file it in the configured inbox project. A task has its own state and can be transitioned.',
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateTaskInput): Promise<ItemRecord> {
    const { projectId, ...common } = input;

    const parentId =
      projectId === INBOX_PROJECT_ID ? await resolveInboxProject(ctx, common) : projectId;

    const depth = await ancestorDepthOf(ctx, parentId);
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

    return insertItem(ctx, common as CommonCreateInput, { id: parentId, depth });
  },
});
