// `get_item` — SCHEMA.md §19 `GET /items/{id}`.
//
// **The slim shape is the default** (MILESTONES.md #107): `{id, title,
// state, headline}` plus the latest checkpoint's own headline. `full: true`
// asks for the whole record back. The reasoning — and why neither a filter
// nor a page size could have fixed what this fixes — is in
// `../items/row.ts`'s `ItemSummaryRecord` header.
//
// **`get_item` is the sharpest case of the three reads this changes.** It is
// `WHERE id = $1`: there is no state filter to default and no page size to
// bound, so before this row there was no parameter anywhere in the operation
// that could make its response smaller. The only lever is which columns come
// back.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  itemColumnsFor,
  toItemRecord,
  toItemSummaryRecord,
  type ItemRecord,
  type ItemSummaryRecord,
  type RawItemRow,
  type RawItemSummaryRow,
} from "../items/row";
import { latestCheckpointHeadline } from "../items/checkpoint-headline";
import { resolveItemId } from "../items/resolve-id";
import { parseDelegateInput } from "../shape-refusal";
import { getItemDetail } from "./get-item-detail";

const inputSchema = z
  .object({
    /**
     * The item's id — a full UUID, or a short id that is a prefix of one
     * (see `../items/resolve-id.ts`). Still `min(1)` rather than a UUID
     * check: this operation never validated the shape, and tightening it
     * here would be a behaviour change riding along with an additive one.
     */
    id: z.string().min(1),
    /**
     * How deep a read. **A stated depth, not an inferred one.**
     *
     * | value | returns |
     * |---|---|
     * | absent / `false` | the slim `GetItemSummaryOutput` |
     * | `true` / `"item"` | the whole `items` row — a bare `ItemRecord` |
     * | `"detail"` | the full detail wrapper, item plus its subtasks, artifacts, history, summary, build status and assignments |
     *
     * Off by default — see `ItemSummaryRecord`. The bare row is wanted by
     * the caller about to *edit* the item, or that genuinely needs
     * `body`/`customFields`; not by the far more common caller asking "what
     * is this".
     *
     * ── Why `true` is kept, and kept meaning exactly what it meant ──────
     *
     * `"detail"` is where `get_item_detail` went. The obvious alternative —
     * make `full: true` return the detail wrapper and retire the flag's old
     * meaning — was rejected, and for a reason stronger than compatibility.
     * `response-size.ts` prescribes `get_item` as the NARROWER call when
     * `get_item_detail` is refused for size. A `full: true` that returned
     * the detail payload would make the escape hatch inherit the failure it
     * escapes: the one call a refused caller was told to fall back to would
     * be refused for the same reason. That is a capability loss, so the
     * flag keeps its meaning and the new depth gets a new spelling.
     *
     * `"item"` is an exact synonym of `true`, so a caller who wants to say
     * which depth they mean can, and every existing `full: true` — in agent
     * definitions, in prose, in `response-size.ts`, on the command line —
     * continues to mean the row it has always meant.
     */
    full: z.union([z.boolean(), z.enum(["item", "detail"])]).default(false),
    /**
     * Forwarded to the detail read under `full: "detail"`, where they bound
     * the two axes that make that response large.
     *
     * Refused by name under any other depth rather than ignored: a caller
     * who sends `artifactLimit` with no `full: "detail"` has asked for
     * something this call cannot do, and silently dropping it would return
     * a shape they did not ask for while reporting success. The bounds are
     * `get_item_detail`'s own, which is where the defaults live — absent
     * stays absent so the delegate decides them.
     */
    historyLimit: z.number().int().min(1).max(500).optional(),
    artifactLimit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * The three depths, after `true`/`false` are normalised to a name.
 *
 * Exported as a value as well as a type because `describe/fold-actions.ts`
 * answers "what verbs does this tool have?" by READING this, never by
 * retyping it — a second copy of a vocabulary is the drift that makes a
 * tool advertise one thing and refuse another.
 */
export const ITEM_DEPTHS = ["summary", "item", "detail"] as const;

export type ItemDepth = (typeof ITEM_DEPTHS)[number];

/**
 * `full` as one of three names.
 *
 * The boolean is a spelling of two of them, so the handler switches on one
 * vocabulary rather than on a union — which is what keeps `true` and
 * `"item"` provably one path rather than two paths that happen to agree.
 */
export function depthOf(full: boolean | "item" | "detail"): ItemDepth {
  if (full === false) return "summary";
  if (full === true) return "item";
  return full;
}

export type GetItemInput = z.infer<typeof inputSchema>;

/**
 * The slim read's result: the item's own summary, and the latest
 * checkpoint's headline if it has one.
 *
 * The checkpoint headline rides along rather than needing a second call
 * because latest-checkpoint is already an indexed single-row read
 * (SCHEMA.md §4) and "what is this / where is it up to" is one question a
 * session asks once, not two.
 */
export interface GetItemSummaryOutput extends ItemSummaryRecord {
  /** The newest checkpoint's one-line BLUF on this item, or null if there is no checkpoint or it has no headline. */
  readonly checkpointHeadline: string | null;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getItem = defineOperation({
  name: "get_item",
  kind: "read",
  summary:
    'Reads one item by id, at a depth you state. Without full it returns the slim shape — id, title, state, headline and the latest checkpoint\'s headline. full: true (or full: "item") returns the whole item row. full: "detail" returns that row plus its subtasks, artifacts, history, summary, build status and assignments, bounded by historyLimit and artifactLimit.',
  contract: {
    rules: [
      {
        fields: ["full"],
        rule: 'Three depths, stated rather than inferred. Absent or false is the slim summary; true and "item" are the same thing — the whole item row — and true is kept meaning exactly that because it is what the response-size guard names as the narrower call when the detail read is refused for size. "detail" is the deepest read and is the one that can itself be refused for size, so it is not a drop-in for true.',
      },
      {
        fields: ["historyLimit", "artifactLimit"],
        rule: 'Both bound the detail read and are accepted only with full: "detail". Sent at any other depth they are refused by name rather than ignored, because a dropped bound would return a shape the caller did not ask for while reporting success.',
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: GetItemInput,
  ): Promise<ItemRecord | GetItemSummaryOutput | unknown> {
    const depth = depthOf(input.full);

    // The two limits belong to the detail read alone. Refused by name under
    // any other depth rather than dropped: a caller who sent one has asked
    // for a bounded detail read, and answering with an unbounded row or a
    // slim summary would be returning a different shape than they asked for
    // while reporting success. Naming the field and the depth that accepts
    // it is the difference between a refusal they can act on and one they
    // have to guess at.
    if (depth !== "detail") {
      const misplaced = (["historyLimit", "artifactLimit"] as const).filter(
        (field) => input[field] !== undefined,
      );
      if (misplaced.length > 0) {
        const list = misplaced.map((field) => `\`${field}\``).join(" and ");
        throw new InvalidInputError(
          `${list} ${misplaced.length === 1 ? "bounds" : "bound"} the detail read and ` +
            `${misplaced.length === 1 ? "is" : "are"} only accepted with \`full: "detail"\`. ` +
            `Resend with \`full: "detail"\`, or drop ${list}.`,
          { fields: [...misplaced] },
        );
      }
    }

    if (depth === "detail") {
      // Dispatches to the operation that already implements this read, in
      // the same `ctx`, so a refusal a caller gets here is the *same object*
      // `get_item_detail` would have thrown — its `code`, its `guard` id and
      // its `fields` identical. No second implementation: notably, the id
      // resolution below belongs to `get_item_detail` too, and running it
      // here as well would resolve a short id twice.
      return getItemDetail.handler(
        ctx,
        parseDelegateInput(
          getItemDetail.name,
          getItemDetail.input,
          {
            id: input.id,
            ...(input.historyLimit === undefined ? {} : { historyLimit: input.historyLimit }),
            ...(input.artifactLimit === undefined ? {} : { artifactLimit: input.artifactLimit }),
          },
          ctx.caller.transport,
        ),
      );
    }

    // A full UUID passes straight through untouched; a short id becomes the
    // one item it identifies, or refuses. Everything below still queries by
    // exact id, so the lookups are unchanged.
    const id = await resolveItemId(ctx.db, input.id);

    if (depth === "item") {
      const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
        `SELECT ${itemColumnsFor(true)} FROM "Item" WHERE "id" = $1`,
        id,
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
      }
      return toItemRecord(row);
    }

    const rows = await ctx.db.$queryRawUnsafe<RawItemSummaryRow[]>(
      `SELECT ${itemColumnsFor(false)} FROM "Item" WHERE "id" = $1`,
      id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }
    return {
      ...toItemSummaryRecord(row),
      checkpointHeadline: await latestCheckpointHeadline(ctx.db, id),
    };
  },
});
