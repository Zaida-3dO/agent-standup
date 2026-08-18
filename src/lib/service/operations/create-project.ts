// `create_project` — SCHEMA.md §1, DECISIONS.md §13c.
//
// A project is a root: no parent, depth 0, and no state of its own — its
// column is derived from its children on read, and the state machine refuses
// to transition one. Naming that in the operation is the point of this
// surface existing separately: a caller asking for a project is asking for
// the container, and gets told so by the tool it called rather than by a
// refusal several calls later when it tries to move the thing it built.
//
// The schema takes no parent field at all, so "a project with a parent" is
// not an input this operation can be given — `.strict()` refuses `parentId`
// and `projectId` as unrecognised keys rather than silently ignoring them,
// so a caller reaching for the wrong operation is told rather than obliged.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  COMMON_CREATE_RULES,
  commonCreateShape,
  insertItem,
  areaSpellingCheck,
  areaSpellingMessage,
  originPersonCheck,
  originPersonMessage,
  type CommonCreateInput,
  type CreatedItem,
  TITLE_CONVENTION_CONTRACT_RULE,
} from "../items/create-core";

const inputSchema = z
  .object(commonCreateShape)
  .strict()
  .refine(originPersonCheck, originPersonMessage)
  .refine(areaSpellingCheck, areaSpellingMessage);

export type CreateProjectInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const createProject = defineOperation({
  name: "create_project",
  kind: "write",
  summary:
    "Creates a project — a root container for tasks. A project has no state of its own; its column is derived from its children, and it cannot be transitioned.",
  contract: {
    // The title convention (MILESTONES.md #131). Declared here so a
    // caller reaches it the moment it is refused on any other field —
    // `runtime.ts` appends a `describe_tool` pointer to every
    // `invalid_input` refusal — and so `describe_tool` can state it on
    // demand rather than it being charged to every turn in `summary`.
    rules: [TITLE_CONVENTION_CONTRACT_RULE, ...COMMON_CREATE_RULES],
    example: {
      title: "Let people reset a forgotten password",
      body: "The reset link expires too fast.",
      area: "web",
      originType: "auto",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateProjectInput): Promise<CreatedItem> {
    return insertItem(ctx, input as CommonCreateInput, { id: null, depth: 0 });
  },
});
