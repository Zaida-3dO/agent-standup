// `create_work` — project, task or subtask behind one tool, chosen with
// `type`.
//
// ── This is the opposite of `create_item`, not a return to it ───────────
//
// `create_item` is deprecated, and its `summary` says exactly why: "kind is
// inferred from whether parentId was supplied, so a caller cannot state
// which kind it wants". That is a real defect and this operation does not
// reintroduce it. The difference is the whole design:
//
//   - **`create_item` infers.** It reads `parentId`, and whatever kind falls
//     out of the parent's depth is the kind you get. Ask for a task, omit
//     the pointer, receive a project — silently, with a successful response
//     and a row of the wrong kind.
//   - **`create_work` requires a declaration and checks it.** `type` is
//     required and is not optional in any mode. The caller states the kind
//     it wants; the server then verifies that what it was given can produce
//     that kind, and **refuses by name when it cannot**.
//
// So a caller that says `type: "task"` and supplies no `projectId` does not
// receive a project. It receives a refusal naming `projectId` and saying
// what to pass. That is a strictly more expressive surface than three tool
// names, because three names cannot express the error at all — `create_task`
// with a missing `projectId` is refused by a schema in the SDK's voice, with
// no `code` and no `fields`, whereas this refusal carries both.
//
// **What is deliberately preserved.** Every kind-correctness check the three
// explicit operations perform still runs, because this operation dispatches
// to them rather than reimplementing them: `create_task` still refuses a
// `projectId` that names a task or subtask, and `create_subtask` still
// refuses a `taskId` that names a project. Those refusals reach the caller
// unedited. The only checks added here are the ones that exist because a
// single tool can now be asked for a combination that no single-purpose tool
// could have been asked for at all.
//
// ── Why only on MCP ─────────────────────────────────────────────────────
//
// The three operations stay registered and stay reachable over HTTP and the
// command line; they are waived off the two MCP adapters only
// (`waivers.ts`). An MCP tool list is sent to the model on every session, so
// three near-identical creates — they share `commonCreateShape`, seventeen
// fields of it, and differ by one parent pointer — spend that budget three
// times to describe one decision.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { parseDelegateInput } from "../shape-refusal";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  COMMON_CREATE_RULES,
  commonCreateShape,
  TITLE_CONVENTION_CONTRACT_RULE,
  type CreatedItem,
  type CreatedWriteRecord,
} from "../items/create-core";
import { createProject } from "./create-project";
import { createTask, INBOX_PROJECT_ID } from "./create-task";
import { createSubtask } from "./create-subtask";

/** The three kinds this tool creates. Depth 0, 1 and 2+ respectively. */
export const CREATE_WORK_TYPES = ["project", "task", "subtask"] as const;

export type CreateWorkType = (typeof CREATE_WORK_TYPES)[number];

/** The guard-shaped id a type/parent mismatch refusal carries, so a caller can match on it rather than on prose. */
export const CREATE_WORK_MISMATCH_GUARD = "items.create_work_type_mismatch";

const inputSchema = z
  .object({
    /**
     * Which kind to create. **Required, and never inferred** — see this
     * module's header for why that is the entire point of the operation.
     */
    type: z.enum(CREATE_WORK_TYPES),
    ...commonCreateShape,
    /**
     * The project a task goes under — required when `type` is `task`, and
     * refused otherwise. The literal `"inbox"` is accepted and resolves to
     * the configured inbox project.
     *
     * Optional *in the schema* and required *by the handler* on purpose. A
     * schema-level requirement cannot be conditional on `type` in a way the
     * SDK will render (a discriminated union advertises no properties at
     * all — see `create-work-encoding` in the tests), and a refusal thrown
     * here can name the field and say what to pass, which the SDK's own
     * parse failure cannot.
     */
    projectId: z.string().trim().min(1).optional(),
    /** The task a subtask goes under — required when `type` is `subtask`, and refused otherwise. */
    taskId: z.string().trim().min(1).optional(),
  })
  .strict();

export type CreateWorkInput = z.infer<typeof inputSchema>;

/**
 * Which parent field each type takes, and which it must not be given.
 *
 * One table, read by both halves of the check below, so "a task needs
 * `projectId`" and "a task must not be given `taskId`" cannot disagree.
 */
const PARENT_FIELD: Readonly<Record<CreateWorkType, "projectId" | "taskId" | null>> = Object.freeze(
  {
    project: null,
    task: "projectId",
    subtask: "taskId",
  },
);

/** What a caller should pass instead, named per type so the refusal ends with an instruction. */
const REMEDY: Readonly<Record<CreateWorkType, string>> = Object.freeze({
  project: "A project is a root container and takes no parent — resend without it.",
  task: `Resend with \`projectId\` set to the project's id, or to the literal "${INBOX_PROJECT_ID}" to file it in the inbox.`,
  subtask: "Resend with `taskId` set to the id of the task this belongs under.",
});

/**
 * Refuses a `type` that does not match the parent fields supplied.
 *
 * Two failures, refused separately because they are different mistakes and
 * a caller can only fix the one it actually made:
 *
 *   1. **The parent this type needs is missing.** `type: "task"` with no
 *      `projectId`. This is the case `create_item` answered by silently
 *      creating a project.
 *   2. **A parent this type does not take was supplied.** `type: "project"`
 *      with a `projectId`, or `type: "task"` with a `taskId`. Refused rather
 *      than ignored: a caller that sent a pointer believes it is being used,
 *      and dropping it produces a correctly-typed row in the wrong place.
 *
 * Both name the field, name what to pass, and say what was wrong — the bar
 * the summary guards set.
 */
function assertTypeMatchesParent(input: CreateWorkInput): void {
  const wanted = PARENT_FIELD[input.type];
  const forbidden = (["projectId", "taskId"] as const).filter((field) => field !== wanted);

  if (wanted !== null && input[wanted] === undefined) {
    throw new InvalidInputError(
      `type is "${input.type}" but \`${wanted}\` was not supplied, and a ${input.type} is defined by having one. ` +
        `Nothing was created — the kind you asked for is not inferred from what you sent. ${REMEDY[input.type]}`,
      { fields: [wanted] },
    );
  }

  for (const field of forbidden) {
    if (input[field] !== undefined) {
      throw new InvalidInputError(
        `type is "${input.type}" but \`${field}\` was supplied, and a ${input.type} does not take one. ` +
          `Nothing was created — the pointer was not ignored, because a create that quietly drops a parent puts real work in the wrong place. ` +
          `${wanted === null ? REMEDY[input.type] : `Either resend with \`${field}\` removed, or set type to "${field === "projectId" ? "task" : "subtask"}" if that is the kind you meant.`}`,
        { fields: [field, "type"] },
      );
    }
  }
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const createWork = defineOperation({
  name: "create_work",
  kind: "write",
  summary:
    'Creates a project, a task or a subtask — say which with type, which is required and is never inferred. A task takes projectId (a project\'s id, or the literal "inbox" to file it in the configured inbox project); a subtask takes taskId; a project takes neither. A type that does not match the parent supplied is refused by name rather than guessed at, so you never receive a kind you did not ask for. Tasks and subtasks have their own state and can be transitioned; a project derives its column from its children and cannot.',
  contract: {
    rules: [
      {
        fields: ["type"],
        rule: "Required. `task` requires `projectId`; `subtask` requires `taskId`; `project` accepts neither. Supplying the wrong parent for the type, or omitting the one it needs, is refused — the kind is never inferred from which pointer happened to be present.",
      },
      TITLE_CONVENTION_CONTRACT_RULE,
      ...COMMON_CREATE_RULES,
    ],
    example: {
      type: "task",
      title: "Let people reset a forgotten password",
      body: "The reset link expires too fast.",
      area: "web",
      originType: "auto",
      projectId: "inbox",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: CreateWorkInput,
  ): Promise<CreatedItem | CreatedWriteRecord> {
    assertTypeMatchesParent(input);

    // Dispatch to the operation that already creates this kind, so every
    // depth check, inbox resolution, short-id resolution and origin rule
    // runs exactly once — in the operation that owns it. `create_task`'s
    // refusal of a non-project parent and `create_subtask`'s refusal of a
    // project parent reach the caller unedited.
    const { type, projectId, taskId, ...common } = input;

    // `parseDelegateInput`, not a bare `.parse()`. The delegate schemas
    // carry two cross-field rules this operation's own schema cannot state
    // — exactly one of `area`/`areas`, and `originPersonId` when
    // `originType` is `person` — so they are first applied here, below the
    // runtime's parse. A bare `.parse()` throws a `ZodError`, which is not a
    // `ServiceError` and so reaches the caller as `internal` with an empty
    // `fields`: a mistake they could have fixed, reported as a server fault
    // and reading as transient. See `shape-refusal.ts` for the full account.
    switch (type) {
      case "project":
        return createProject.handler(
          ctx,
          parseDelegateInput(createProject.name, createProject.input, common, ctx.caller.transport),
        );
      case "task":
        return createTask.handler(
          ctx,
          parseDelegateInput(
            createTask.name,
            createTask.input,
            { ...common, projectId },
            ctx.caller.transport,
          ),
        );
      case "subtask":
        return createSubtask.handler(
          ctx,
          parseDelegateInput(
            createSubtask.name,
            createSubtask.input,
            { ...common, taskId },
            ctx.caller.transport,
          ),
        );
    }
  },
});
