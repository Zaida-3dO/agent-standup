// `create_item` — **deprecated**. Prefer `create_project`, `create_task` or
// `create_subtask`, each of which names the kind it makes.
//
// **Why it is kept rather than removed.** It is reachable from four adapters
// and is the write behind `POST /api/items` and `standup item create`, so
// deleting it turns every existing caller's next call into an unrecognised
// operation with nothing in the refusal to say what to call instead. Kept,
// the same caller keeps working and the tool description tells it where to
// go — which is the only channel an agent reads. The behaviour is unchanged
// to the byte: it delegates to the same shared core the three explicit
// operations use, so there is no second implementation to drift.
//
// **What is deliberately not done.** No runtime warning is emitted and no
// input is refused. A rejection would be a breaking change wearing a
// deprecation's clothes, and a log line is read by an operator rather than
// by the agent making the call. The deprecation lives in the one place its
// audience actually looks: the `summary`, which is what an MCP client shows
// as the tool's description and what `standup --help` prints.
//
// **The removal condition, so this does not become permanent by default.**
// It goes when nothing in this repository calls it and the HTTP route and
// CLI verb have been re-pointed — at which point removing it is a one-line
// registry edit, because there is no logic here to move.
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
  toCreatedWriteRecord,
  type CommonCreateInput,
  type CreatedItem,
  type CreatedWriteRecord,
  TITLE_CONVENTION_CONTRACT_RULE,
} from "../items/create-core";

const inputSchema = z
  .object({
    ...commonCreateShape,
    /** Null/omitted = a root project. This is the ambiguity the three explicit operations remove. */
    parentId: z.string().min(1).optional(),
  })
  .strict()
  .refine(originPersonCheck, originPersonMessage)
  .refine(areaSpellingCheck, areaSpellingMessage);

export type CreateItemInput = z.infer<typeof inputSchema>;

/**
 * What a caller cannot read off the schema above (MILESTONES.md #111).
 *
 * Declared here, beside the `.refine()` and the lookups it describes, rather
 * than in a catalogue of every operation's rules: a rule and its enforcement
 * changing together is the only arrangement in which they cannot disagree.
 * The `fields` on each entry are the same paths the corresponding refusal
 * carries, so a caller who has been refused can match the rule to the
 * rejection without reading prose.
 *
 * `create_item` is deprecated (see the module comment) but its rules have
 * not changed — a caller still reaching for it via `describe_tool` gets the
 * same accurate contract `create_project`/`create_task`/`create_subtask`
 * would give it, just from the operation whose summary tells it where to go
 * instead.
 */
const contract = {
  rules: [
    {
      fields: ["originType", "originPersonId", "driveMode"],
      rule:
        "`originType` reads as optional in the schema and is required in practice: a session " +
        "that registered with a `personId` declares a person origin once and inherits it — " +
        "`originType`, `originPersonId` and `driveMode` — on every later create, while a " +
        "session that declared nothing must name `originType` per call. An explicit value " +
        "always wins over the declaration. JSON Schema can express neither the inheritance " +
        "nor the requirement, so neither appears in the advertised schema.",
    },
    {
      fields: ["originPersonId", "originType"],
      rule:
        "`originPersonId` is required when `originType` is `person`, and must name an existing " +
        "person. It is not required for `source` or `auto`. JSON Schema cannot express a " +
        "conditionally-required field, so this does not appear in the advertised schema.",
    },
    {
      fields: ["parentId"],
      rule:
        "`parentId` decides what is created: omitted makes a project, a project's id makes a " +
        "task, a task's id makes a subtask. `kind` is derived from that depth and is not a " +
        "field you send. A create that would exceed the configured `items.max_depth` is refused.",
    },
    {
      fields: ["repo"],
      rule:
        "`repo` must be the id of an existing, unarchived repo — repos are never created " +
        "implicitly by naming one here. `area`, by contrast, is a free label and is created on " +
        "first use, so the two fields behave differently despite looking alike.",
    },
    TITLE_CONVENTION_CONTRACT_RULE,
  ],
  example: {
    title: "Add a rate limit to the public endpoint",
    body: "The endpoint is unauthenticated and unbounded.",
    area: "api",
    originType: "auto",
  },
} as const;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const createItem = defineOperation({
  name: "create_item",
  kind: "write",
  summary:
    "Deprecated — use create_project, create_task or create_subtask instead. Creates an item whose kind is inferred from whether parentId was supplied, so a caller cannot state which kind it wants.",
  contract,
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: CreateItemInput,
  ): Promise<CreatedItem | CreatedWriteRecord> {
    const { parentId, ...common } = input;

    // Applied at both returns below. The parentless branch returns down an
    // earlier path, which is the same trap #234 called out on
    // `reparent_item`'s `parentId: null` early return — narrowing only the
    // final return would leave the root-item create still echoing the whole
    // record, and no test of the ordinary path would notice.
    const shape = (created: CreatedItem): CreatedItem | CreatedWriteRecord =>
      input.full ? created : toCreatedWriteRecord(created);

    if (parentId === undefined) {
      return shape(await insertItem(ctx, common as CommonCreateInput, { id: null, depth: 0 }));
    }

    const depth = await ancestorDepthOf(ctx, parentId);
    if (depth === undefined) {
      throw new NotFoundError(`No such parent item: ${parentId}.`, { fields: ["parentId"] });
    }

    return shape(await insertItem(ctx, common as CommonCreateInput, { id: parentId, depth }));
  },
});
