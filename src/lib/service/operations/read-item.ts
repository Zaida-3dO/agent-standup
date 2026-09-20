// `read_item` — the three bounded reads of one item, behind one tool.
//
// ── Why these three and why one tool ────────────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. These
// three are one capability seen three times: they are what a caller reaches
// for when the whole-item read will not fit, and each returns a different
// unbounded axis of that same item in windows — its body by character
// offset, its history by event id, its artifacts by seq. A caller reaching
// for any of them has already decided it is reading one item in pieces; the
// only remaining question is which piece, which is exactly what an `action`
// states.
//
// The grouping is not "these three happened to be adjacent". It is the set
// the response-size guard prescribes: refuse `get_item` at `full: "detail"`
// and its advice sends the caller here, to whichever axis was the reason it
// did not fit. Folding them keeps that advice one name plus an action
// rather than three names a caller has to hold separately.
//
// ── All three are kept, and waived off MCP only ─────────────────────────
//
// They stay registered, stay reachable over HTTP and the command line, and
// keep their own tests. Nothing here reimplements them: each action
// dispatches to the operation that already performs it, through the same
// `ctx`, so a refusal a caller gets here is the *same object* the unfolded
// operation would have thrown — its `code`, its `guard` id and its `fields`
// identical on both surfaces. That is what makes waiving them a narrowing
// of the tool list rather than a narrowing of the capability, and it is the
// property `tests/read-item-fold.test.ts` observes rather than assumes.
//
// ── The subject is `id`, on every action, deliberately ──────────────────
//
// All three delegates call it `id` and all three schemas are `.strict()`,
// so `itemId` — the name the write tools use for the same thing — is
// refused. The fold keeps `id` rather than accepting the friendlier name
// and translating, because a fold that renamed its subject would have two
// vocabularies for one concept and no way for a caller to tell which
// surface wanted which.
//
// ── `full` here is NOT `get_item`'s three-valued depth ──────────────────
//
// `get_item` takes a `full` that names one of three depths. The `full` on
// this tool is the delegates' own boolean, on two of the three actions, and
// means "include the bodies this read omits by default". Same word, two
// tools, unrelated meanings — stated in a contract rule below so a caller
// carrying the spelling from one is not quietly misled by the other.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { rejectForeignFields, type FoldForwarding } from "../foreign-fields";
import { ARTIFACT_KINDS } from "./record-artifact";
import { getItemBody } from "./get-item-body";
import { getItemHistory } from "./get-item-history";
import { getItemArtifacts } from "./get-item-artifacts";

/** The reads this tool folds. */
export const READ_ITEM_ACTIONS = ["body", "history", "artifacts"] as const;

export type ReadItemAction = (typeof READ_ITEM_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is
 * made from, so a required field and the sentence naming it cannot
 * disagree. `describe_tool` reads this same table, so what the tool
 * advertises as required and what it actually refuses cannot drift.
 *
 * Every action needs only the item, because every one of these reads is
 * "this item, in windows" — the paging fields all carry defaults their own
 * operation declares, and restating them here would put a default in two
 * places.
 */
export const READ_ITEM_ACTION_FIELDS: Readonly<
  Record<ReadItemAction, { readonly required: readonly string[] }>
> = Object.freeze({
  body: { required: ["id"] },
  history: { required: ["id"] },
  artifacts: { required: ["id"] },
});

const inputSchema = z
  .object({
    /** Which read. The one field that decides what the rest of the call means. */
    action: z.enum(READ_ITEM_ACTIONS),
    /**
     * The item — a full UUID, or a short id that is a prefix of one.
     *
     * `id`, not `itemId`: all three delegates declare it that way and all
     * three are `.strict()`. See this module's header.
     */
    id: z.string().min(1).optional(),

    // ── paging, shared in spelling but not in units ────────────────────
    /**
     * How much of one page.
     *
     * Bounded by the operation rather than here, and the bounds genuinely
     * differ: `body` counts characters and allows a far larger window than
     * `history` and `artifacts`, which count rows. Restating a maximum here
     * would either refuse a legal call or advertise one that is refused a
     * layer down, and both are worse than letting the operation own it.
     */
    limit: z.number().int().positive().optional(),
    /** `body` only — where in the body to start, in characters. */
    offset: z.number().int().min(0).optional(),
    /**
     * `history` and `artifacts` — the page marker each returns as
     * `nextCursor`. Left loose here; each operation's own schema states the
     * shape it accepts and refuses anything else by name.
     */
    cursor: z.string().min(1).optional(),
    /**
     * `history` and `artifacts` — include the bodies each omits by default.
     *
     * **Not `get_item`'s depth.** This is the delegates' own boolean; see
     * this module's header and the contract rule below.
     */
    full: z.boolean().optional(),

    // ── `artifacts` ────────────────────────────────────────────────────
    /** One artifact, in full, instead of a page of them. */
    artifactId: z.string().min(1).optional(),
    /** Narrow the page to one kind of artifact. */
    kind: z.enum(ARTIFACT_KINDS).optional(),
  })
  .strict();

export type ReadItemInput = z.infer<typeof inputSchema>;

/**
 * Fields this tool accepts that a given action's delegate does not.
 *
 * Refused by name rather than dropped. A silently ignored field returns a
 * page the caller did not ask for while reporting success — they asked for
 * an offset into a body and got page one of a history, with nothing
 * anywhere saying so. Naming the field and the action is what turns that
 * into something they can fix in one step.
 */
/**
 * Which delegate each action forwards to, for the foreign-field guard.
 *
 * **This replaced a hand-written `NOT_ON_ACTION` table that listed the same
 * eight fields.** The table was correct when written and this fold was, at
 * the time of the sweep, the only one besides `ownership` with any
 * foreign-field rejection at all. It is derived now for the reason the
 * whole sweep exists: a list of what an action does NOT take is a second
 * statement of what it DOES take, maintained by a different edit, and a
 * field added to `get_item_artifacts` would have had to be remembered in
 * two places or be silently dropped on the other two actions.
 *
 * The derived set is identical to what the table asserted — `body` refuses
 * cursor/full/artifactId/kind, `history` refuses offset/artifactId/kind,
 * `artifacts` refuses offset — and `tests/read-item-fold.test.ts` pins that
 * equivalence rather than it being asserted here.
 */
export const FORWARDING: FoldForwarding<ReadItemAction> = Object.freeze({
  body: { schema: getItemBody.input },
  history: { schema: getItemHistory.input },
  artifacts: { schema: getItemArtifacts.input },
});

/** Refuses an action that is missing a field it cannot run without. */
function requireFields(input: ReadItemInput): void {
  const missing = READ_ITEM_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof ReadItemInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `read_item action "${input.action}" requires ${list}, which ${
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
export const readItem = defineOperation({
  name: "read_item",
  kind: "read",
  summary:
    "Reads one item in windows when the whole thing will not fit — say which part with action. body pages the body by character offset. history pages the notes and checkpoints newest first, and needs full for their text. artifacts pages the plans, reviews, commits and check runs, with kind to filter and artifactId for one in full. The subject is id on every action, never itemId.",
  contract: {
    rules: [
      {
        fields: ["action", "id"],
        rule: "Every action reads one item and every action names it `id`, not `itemId` — the reads declare it that way and refuse the other spelling. body takes offset and limit in CHARACTERS; history and artifacts take cursor and limit in ROWS, and each returns the cursor for its next page.",
      },
      {
        fields: ["full"],
        rule: 'This full is a plain true/false meaning "include the bodies this read leaves out", on actions history and artifacts. It is NOT get_item\'s full, which names one of three depths — same word, different tools, unrelated meanings. On action history it is what turns a slim ledger into the note and checkpoint TEXT, which is usually what a caller reading history actually wants.',
      },
      {
        fields: ["offset", "cursor", "artifactId", "kind"],
        rule: "Each of these belongs to some actions and not others, and one sent to an action that cannot use it is refused by name rather than ignored — a dropped page marker would return page one while reporting success. offset is body only; cursor is history and artifacts; artifactId and kind are artifacts only.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ReadItemInput): Promise<unknown> {
    rejectForeignFields("read_item", input.action, input, FORWARDING);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()`
    // schema accepts, and forwards each as it arrived — absent stays
    // absent, so every default belongs to the operation that declares it.
    switch (input.action) {
      case "body":
        return getItemBody.handler(
          ctx,
          parseDelegateInput(
            getItemBody.name,
            getItemBody.input,
            {
              id: input.id,
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            ctx.caller.transport,
          ),
        );
      case "history":
        return getItemHistory.handler(
          ctx,
          parseDelegateInput(
            getItemHistory.name,
            getItemHistory.input,
            {
              id: input.id,
              ...(input.full === undefined ? {} : { full: input.full }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
            ctx.caller.transport,
          ),
        );
      case "artifacts":
        return getItemArtifacts.handler(
          ctx,
          parseDelegateInput(
            getItemArtifacts.name,
            getItemArtifacts.input,
            {
              id: input.id,
              ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              ...(input.full === undefined ? {} : { full: input.full }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
