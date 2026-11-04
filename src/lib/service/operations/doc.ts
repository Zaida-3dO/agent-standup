// `doc` — reading, listing and patching an item's documents, behind one tool.
//
// ── Why these three ─────────────────────────────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. These
// three are one capability seen from three sides: the keyed JSON documents
// attached to an item. `get` reads some entries of one document, `list`
// reads one document across an item's children, `patch` writes some keys. A
// caller reaching for any of them has already decided it is working with a
// document; the only remaining question is which direction, which is exactly
// what an `action` states. They also refer to each other: `get` returns the
// `rev` that `patch` takes as `ifRev`, and a `patch` conflict tells the
// caller to read again.
//
// ── All three are kept, and waived off MCP only ─────────────────────────
//
// They stay registered, stay reachable over HTTP
// (`api/items/{id}/docs/{doc}` and its `children`) and on the command line,
// and keep their own tests. Each action dispatches to the operation that
// already performs it, through the same `ctx`: the delegate runs through
// `parseDelegateInput` and its own handler, so every refusal reaches an MCP
// caller through this tool unchanged — same `code`, same `fields`.
//
// ── The item is named differently per action, so it is two fields ───────
//
// `get` and `patch` act on one item's document and take `itemId`; `list`
// acts on the children of an item and takes `parentId`. Collapsing them onto
// one field would make the most consequential field on the tool mean
// whatever the action happened to be, so each keeps the name its delegate
// declares.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { rejectForeignFields, type FoldForwarding } from "../foreign-fields";
import { docGet } from "./doc-get";
import { docList } from "./doc-list";
import { docPatch } from "./doc-patch";

/** The verbs this tool folds. */
export const DOC_ACTIONS = ["get", "list", "patch"] as const;

export type DocAction = (typeof DOC_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is
 * made from, so a required field and the sentence naming it cannot
 * disagree. `describe_tool` reads this same table.
 */
export const DOC_ACTION_FIELDS: Readonly<
  Record<DocAction, { readonly required: readonly string[] }>
> = Object.freeze({
  get: { required: ["itemId", "doc"] },
  list: { required: ["parentId", "doc"] },
  patch: { required: ["itemId", "doc"] },
});

const inputSchema = z
  .object({
    /** Which direction. The one field that decides what the rest means. */
    action: z.enum(DOC_ACTIONS),
    /** The document's name, e.g. `progress`. Required by every action. */
    doc: z.string().min(1).optional(),

    // ── `get` and `patch` ──────────────────────────────────────────────
    /** The item the document belongs to — a full UUID, or a short id. */
    itemId: z.string().min(1).optional(),

    // ── `list` ─────────────────────────────────────────────────────────
    /** The item whose children's documents to read — a full UUID, or a short id. */
    parentId: z.string().min(1).optional(),

    // ── `get` ──────────────────────────────────────────────────────────
    /** Read just these keys. Not together with `prefix`. */
    keys: z.array(z.string().min(1)).optional(),
    /** Read every key that starts with this. Not together with `keys`. */
    prefix: z.string().min(1).optional(),

    // ── `get` and `list` ───────────────────────────────────────────────
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).optional(),
    /** At most this many entries per page; the delegate owns the default and the ceiling. */
    limit: z.number().int().min(1).optional(),

    // ── `patch` ────────────────────────────────────────────────────────
    /** Keys to write, each with its new value (any JSON value). */
    set: z.record(z.string(), z.unknown()).optional(),
    /** Keys to remove. */
    delete: z.array(z.string().min(1)).optional(),
    /** The document revision this patch was made against, as `get` reported it. */
    ifRev: z.number().int().min(0).optional(),
  })
  .strict();

export type DocInput = z.infer<typeof inputSchema>;

/**
 * Which delegate each action forwards to, for the foreign-field guard.
 *
 * Derived from the delegates' own schemas, so a field one action does not
 * take (`set` on a `get`, say) is refused by name rather than dropped.
 */
export const FORWARDING: FoldForwarding<DocAction> = Object.freeze({
  get: { schema: docGet.input },
  list: { schema: docList.input },
  patch: { schema: docPatch.input },
});

/** Refuses an action that is missing a field it cannot run without. */
function requireFields(input: DocInput): void {
  const missing = DOC_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof DocInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `doc action "${input.action}" requires ${list}, which ${
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
export const doc = defineOperation({
  name: "doc",
  kind: "write",
  summary:
    "Works with an item's documents — keyed JSON entries that hold anything big, technical or agent-only, instead of the title, headline, body or customFields. Say which with action. get reads entries of one document (itemId, doc; optionally keys or prefix) and returns its rev. list reads one document across an item's children (parentId, doc), paged. patch writes some keys (itemId, doc, set and/or delete) and leaves every other key alone; pass ifRev (the rev get returned) to be refused if someone has written those keys since.",
  contract: {
    rules: [
      {
        fields: ["action", "itemId", "parentId"],
        rule: "get and patch name the item that owns the document with itemId. list names the item whose CHILDREN's documents to read with parentId. Each action takes only the fields its own operation declares, and a field that belongs to another action is refused by name.",
      },
      {
        fields: ["keys", "prefix"],
        rule: "On get, give keys or prefix, not both. With neither, every key is read, in pages: follow nextCursor until it is null.",
      },
      {
        fields: ["set", "delete", "ifRev"],
        rule: "On patch, name at least one key in set or delete, at most 100 between them, none in both. ifRev is checked per key: the patch is refused if any key it names was written after that revision.",
      },
    ],
    example: { action: "get", itemId: "0f8e3a52", doc: "progress", prefix: "session-" },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DocInput): Promise<unknown> {
    rejectForeignFields("doc", input.action, input, FORWARDING);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()`
    // schema accepts, and forwards each as it arrived — absent stays
    // absent, so every default belongs to the operation that declares it.
    switch (input.action) {
      case "get":
        return docGet.handler(
          ctx,
          parseDelegateInput(
            docGet.name,
            docGet.input,
            {
              itemId: input.itemId,
              doc: input.doc,
              ...(input.keys === undefined ? {} : { keys: input.keys }),
              ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            ctx.caller.transport,
          ),
        );
      case "list":
        return docList.handler(
          ctx,
          parseDelegateInput(
            docList.name,
            docList.input,
            {
              parentId: input.parentId,
              doc: input.doc,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            ctx.caller.transport,
          ),
        );
      case "patch":
        return docPatch.handler(
          ctx,
          parseDelegateInput(
            docPatch.name,
            docPatch.input,
            {
              itemId: input.itemId,
              doc: input.doc,
              ...(input.set === undefined ? {} : { set: input.set }),
              ...(input.delete === undefined ? {} : { delete: input.delete }),
              ...(input.ifRev === undefined ? {} : { ifRev: input.ifRev }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
