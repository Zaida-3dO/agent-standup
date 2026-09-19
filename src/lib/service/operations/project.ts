// `project` — the project reads and the repair behind one tool, chosen with
// `action`.
//
// ── Why this is folded, and why only on MCP ─────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. Three
// verbs spend that budget three times to describe one subject: listing
// projects, reading one in full, and repairing one whose children finished
// without it noticing. A caller reaching for any of them has already decided
// it is working on a project; what it has not yet said is which verb.
//
// The three operations are **not removed**. They stay registered, stay
// reachable over HTTP and the command line, and keep their own tests; they
// are waived off the two MCP adapters only.
//
// ── Why `create` is NOT an action here ──────────────────────────────────
//
// `create_project` is already folded into `create_work`, which takes the
// kind as a declared field. Adding a `create` action here would give one
// capability two MCP spellings and reintroduce the question `create_work`
// exists to answer — which kind of thing is being made — in a second place.
// A caller creating a project uses `create_work`; this tool reads and
// repairs.
//
// ── No second implementation ────────────────────────────────────────────
//
// Every action dispatches to the operation that already implements it,
// through the same `ctx` it was handed. A refusal a caller gets here is the
// *same object* the unfolded operation would have thrown, so its `code`, its
// `guard` id and its `fields` are identical on both surfaces.
//
// ── The one field that must not be defaulted here ───────────────────────
//
// **`apply` decides whether `repair` writes anything**, and it is forwarded
// exactly as it arrived. `repair_stuck_projects` defaults it to false, so a
// call that does not mention it reports what it WOULD change and writes
// nothing. Defaulting it in this fold would move that decision out of the
// operation that owns it, and a fold that sent `apply: false` explicitly
// would be restating a rule that could then drift from the one it copies.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { rejectForeignFields, type FoldForwarding } from "../foreign-fields";
import { getProjects } from "./get-projects";
import { getProjectDetail } from "./get-project-detail";
import { repairStuckProjects } from "./repair-stuck-projects";

/** The verbs this tool folds. */
export const PROJECT_ACTIONS = ["list", "detail", "repair"] as const;

export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is made
 * from, so a required field and the sentence naming it cannot disagree.
 */
export const PROJECT_ACTION_FIELDS: Readonly<
  Record<ProjectAction, { required: readonly string[] }>
> = Object.freeze({
  list: { required: [] },
  detail: { required: ["id"] },
  repair: { required: ["id"] },
});

const inputSchema = z
  .object({
    /** Which verb. The one field that decides what the rest of the call means. */
    action: z.enum(PROJECT_ACTIONS),
    /**
     * The project, for `detail` and `repair`.
     *
     * One field rather than an `id` and a `projectId`: both actions name the
     * same thing, and two spellings of one subject is the ambiguity a folded
     * tool exists to remove. The `repair` branch maps it onto that
     * operation's own `projectId`.
     */
    id: z.string().trim().min(1).optional(),

    // ── `list` ─────────────────────────────────────────────────────────
    area: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    includeCompleted: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),

    // ── `detail` ───────────────────────────────────────────────────────
    activityLimit: z.number().int().positive().optional(),
    childLimit: z.number().int().positive().optional(),

    // ── Shared by `list` and `detail` ──────────────────────────────────
    includeArchived: z.boolean().optional(),

    // ── `repair` ───────────────────────────────────────────────────────
    /**
     * Whether the repair writes.
     *
     * Forwarded as it arrived. `repair_stuck_projects` defaults it to false,
     * so an unmentioned `apply` reports what it would change without
     * changing it — see this module's header.
     */
    apply: z.boolean().optional(),
  })
  .strict();

export type ProjectInput = z.infer<typeof inputSchema>;

/** Refuses an action that is missing a field it cannot run without. */
/**
 * Which delegate each action forwards to, for the foreign-field guard.
 *
 * `repair` carries the one rename on this tool: the fold calls the subject
 * `id` for every action, and `repair_stuck_projects` declares it as
 * `projectId`. Stated here so the guard answers in the CALLER's vocabulary
 * — a caller passing `id` to `repair` must not be told their own field is
 * foreign because the delegate spells it differently.
 */
const FORWARDING: FoldForwarding<ProjectAction> = Object.freeze({
  list: { schema: getProjects.input },
  detail: { schema: getProjectDetail.input },
  repair: { schema: repairStuckProjects.input, renames: { id: "projectId" } },
});

function requireFields(input: ProjectInput): void {
  const missing = PROJECT_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof ProjectInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `project action "${input.action}" requires ${list}, which ${
      missing.length === 1 ? "was" : "were"
    } not supplied. Resend the call with ${list} set.`,
    { fields: missing },
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const project = defineOperation({
  name: "project",
  kind: "write",
  summary:
    "Works with projects — say which with action. list reads the projects, newest activity first, optionally narrowed by area or repo. detail reads one in full, with its children and recent activity. repair finds tasks under a project that finished while the project still reads as unfinished, and fixes them only when apply is passed — without it, it reports what it would change and writes nothing. Create a project with create_work, not here.",
  contract: {
    rules: [
      {
        fields: ["action"],
        rule: "detail and repair require id; list requires nothing. A missing field is refused by name.",
      },
      {
        fields: ["apply"],
        rule: "On action repair, omitting `apply` is a DRY RUN: the call reports the tasks it would reconcile and writes nothing. Pass apply true to make the change. This is the operation's own default, not a rule restated by the folding tool.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ProjectInput): Promise<unknown> {
    rejectForeignFields("project", input.action, input, FORWARDING);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()` schema
    // accepts, and forwards each one as it arrived — absent stays absent, so
    // every default belongs to the operation that declares it.
    switch (input.action) {
      case "list":
        return getProjects.handler(
          ctx,
          parseDelegateInput(
            getProjects.name,
            getProjects.input,
            {
              ...(input.area === undefined ? {} : { area: input.area }),
              ...(input.repo === undefined ? {} : { repo: input.repo }),
              ...(input.includeCompleted === undefined
                ? {}
                : { includeCompleted: input.includeCompleted }),
              ...(input.includeArchived === undefined
                ? {}
                : { includeArchived: input.includeArchived }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
            ctx.caller.transport,
          ),
        );
      case "detail":
        return getProjectDetail.handler(
          ctx,
          parseDelegateInput(
            getProjectDetail.name,
            getProjectDetail.input,
            {
              id: input.id,
              ...(input.activityLimit === undefined ? {} : { activityLimit: input.activityLimit }),
              ...(input.childLimit === undefined ? {} : { childLimit: input.childLimit }),
              ...(input.includeArchived === undefined
                ? {}
                : { includeArchived: input.includeArchived }),
            },
            ctx.caller.transport,
          ),
        );
      case "repair":
        return repairStuckProjects.handler(
          ctx,
          parseDelegateInput(
            repairStuckProjects.name,
            repairStuckProjects.input,
            {
              // That operation names the project `projectId`; this tool calls
              // it `id` for every action, so the two spellings meet here
              // rather than in the caller.
              projectId: input.id,
              ...(input.area === undefined ? {} : { area: input.area }),
              ...(input.apply === undefined ? {} : { apply: input.apply }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
