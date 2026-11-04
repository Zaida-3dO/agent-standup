// `doc_patch` — writes some keys of one of an item's documents.
//
// ── What it is for ──────────────────────────────────────────────────────
//
// Anything big, technical or agent-only — a plan, a log, a progress page —
// is kept in a document rather than in the title, headline, body or
// `customFields` a person reads. A document is a set of keyed JSON entries
// (`ItemDocEntry`), and a patch names the keys it changes: `set` writes
// them, `delete` removes them, and every other key is left exactly as it
// was. That is the point of the shape. A writer that owns one key does not
// read the other thirty to write its own, and two sessions writing different
// keys do not overwrite each other.
//
// ── Per-key writes, in the settings pattern ─────────────────────────────
//
// `patch_settings` is the precedent: validate every key before any write, so
// a refusal is a clean no-op; apply the lot in the call's one transaction;
// leave one audit row for the act. The audit row here is one `doc_change`
// event per patch, which names the keys and their sizes and the new
// revision — **and never a value**. The ledger is read in slices by every
// "what happened" view, and a value in it would put the document back into
// every one of them, which is the problem documents exist to remove.
//
// ── The revision, and what `ifRev` protects ─────────────────────────────
//
// Each document carries a revision that goes up by one for every patch that
// changes it. A caller that read the document at revision N and passes
// `ifRev: N` is refused if the document has moved on, with the current
// revision in the refusal, instead of silently overwriting what another
// session wrote in between. The comparison is against the whole document,
// not the keys being written: a caller doing read-modify-write on a key
// cannot tell a neighbour's unrelated write from a related one, and a false
// clash costs a re-read where a missed one costs somebody's work. `ifRev` is
// optional; a writer that owns its key outright simply omits it.
//
// Two patches to one document are applied one after the other: the document
// row is locked for the rest of the transaction before the revision is read,
// so a second patch waits for the first and then sees the revision it left.
//
// A patch that changes nothing — every `set` already holds that value, every
// `delete` names an absent key — writes nothing, bumps nothing and appends
// no event, and says so (`changed: false`).
import { z } from "zod";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent } from "@/lib/events";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { resolveItemId } from "../items/resolve-id";
import {
  MAX_DOC_KEYS_PER_PATCH,
  byteLength,
  docKeySchema,
  docNameSchema,
  serialiseValue,
} from "./documents-shared";

const inputSchema = z
  .object({
    /** The item the document belongs to — a full UUID, or a short id that is a prefix of one. */
    itemId: z.string().min(1),
    /** The document's name, e.g. `progress`. It comes into being with its first entry. */
    doc: docNameSchema,
    /** Keys to write, each with its new value (any JSON value, `null` included). */
    set: z.record(docKeySchema, z.unknown()).optional(),
    /** Keys to remove. A key that is not there is ignored. */
    delete: z.array(docKeySchema).optional(),
    /**
     * The document revision this patch was made against, as `doc_get`
     * reported it. The patch is refused if the document is at any other
     * revision. Omit it to write without checking.
     */
    ifRev: z.number().int().min(0).optional(),
  })
  .strict();

export type DocPatchInput = z.infer<typeof inputSchema>;

/** One key a patch changed, as the event and the reply both report it. */
export interface DocKeyChange {
  readonly key: string;
  readonly op: "created" | "updated" | "deleted";
  /** UTF-8 bytes of the value written, or of the value removed for a delete. */
  readonly bytes: number;
}

export interface DocPatchOutput {
  readonly itemId: string;
  readonly doc: string;
  /** The document's revision after this call. Unchanged when `changed` is false. */
  readonly rev: number;
  /** False when the patch matched what was already stored, so nothing was written. */
  readonly changed: boolean;
  /** The keys actually written or removed. Empty when `changed` is false. */
  readonly keys: readonly DocKeyChange[];
  /** The `doc_change` event this patch appended, as a string — `null` when nothing changed. */
  readonly eventId: string | null;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
export const docPatch = defineOperation({
  name: "doc_patch",
  kind: "write",
  summary:
    "Writes some keys of one of an item's documents: `set` {key: value} writes entries, `delete` [keys] removes them, and every other key is left alone. Documents are where anything big, technical or agent-only goes, instead of the title, headline, body or customFields. Pass `ifRev` (the rev doc_get returned) to be refused if someone else wrote since. Records one small event naming the keys and sizes, never the values.",
  contract: {
    rules: [
      {
        fields: ["set", "delete"],
        rule: "At least one of `set` and `delete` must name a key, at most 100 keys between them, and no key may appear in both.",
      },
      {
        fields: ["set"],
        rule: "A value is any JSON value, up to 40,000 characters serialised. A larger one is refused: split it across several keys.",
      },
      {
        fields: ["ifRev"],
        rule: "When given, the patch is refused unless the document is at exactly that revision. A document nobody has written is at revision 0.",
      },
    ],
    example: { itemId: "0f8e3a52", doc: "progress", set: { meta: { title: "Plan" } }, ifRev: 0 },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DocPatchInput): Promise<DocPatchOutput> {
    const setEntries = Object.entries(input.set ?? {});
    const deleteKeys = [...new Set(input.delete ?? [])];

    // Everything that can be refused without touching the database is
    // refused first, so a bad patch is a no-op by construction rather than
    // by rollback.
    if (setEntries.length === 0 && deleteKeys.length === 0) {
      throw new InvalidInputError(
        "A patch needs at least one key in `set` or `delete`; this one names none.",
        { fields: ["set", "delete"] },
      );
    }
    if (setEntries.length + deleteKeys.length > MAX_DOC_KEYS_PER_PATCH) {
      throw new InvalidInputError(
        `A patch may name at most ${MAX_DOC_KEYS_PER_PATCH} keys between \`set\` and \`delete\`; this one names ${setEntries.length + deleteKeys.length}. Send it as several patches.`,
        { fields: ["set", "delete"] },
      );
    }
    const setKeys = new Set(setEntries.map(([key]) => key));
    const both = deleteKeys.filter((key) => setKeys.has(key));
    if (both.length > 0) {
      throw new InvalidInputError(
        `The key "${both[0]}" is in both \`set\` and \`delete\`. A key is either written or removed in one patch, not both.`,
        { fields: ["delete"] },
      );
    }
    const serialised = setEntries.map(([key, value]) => ({
      key,
      json: serialiseValue(key, value),
    }));

    const itemId = await resolveItemId(ctx.db, input.itemId, "itemId");
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${itemId}.`, { fields: ["itemId"] });
    }

    // Lock the document. The insert makes sure the row exists (and, if a
    // concurrent patch is creating it, waits for that patch to finish); the
    // locking select then holds it until this transaction ends. Everything
    // below therefore sees the revision the previous patch left, and the
    // next patch sees ours.
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "ItemDoc" ("itemId", "doc") VALUES ($1, $2)
       ON CONFLICT ("itemId", "doc") DO NOTHING`,
      itemId,
      input.doc,
    );
    const docRows = await ctx.db.$queryRawUnsafe<{ rev: number }[]>(
      `SELECT "rev" FROM "ItemDoc" WHERE "itemId" = $1 AND "doc" = $2 FOR UPDATE`,
      itemId,
      input.doc,
    );
    const currentRev = Number(docRows[0]?.rev ?? 0);

    if (input.ifRev !== undefined && input.ifRev !== currentRev) {
      throw new ConflictError(
        `The document "${input.doc}" on ${itemId} is at revision ${currentRev}, not ${input.ifRev}: it was written to after you read it. Read it again with doc_get and redo the patch against that revision.`,
        { fields: ["ifRev"], details: { currentRev, ifRev: input.ifRev } },
      );
    }

    // What each key would become, judged by the database so that "the same
    // value" means what jsonb says it means (key order and spacing in the
    // sent JSON are not differences).
    const existing = serialised.length
      ? await ctx.db.$queryRawUnsafe<{ key: string; exists: boolean; same: boolean }[]>(
          `SELECT s."key", (e."key" IS NOT NULL) AS "exists",
                  COALESCE(e."value" = s."value"::jsonb, false) AS "same"
           FROM unnest($3::text[], $4::text[]) AS s("key", "value")
           LEFT JOIN "ItemDocEntry" e
             ON e."itemId" = $1 AND e."doc" = $2 AND e."key" = s."key"`,
          itemId,
          input.doc,
          serialised.map((entry) => entry.key),
          serialised.map((entry) => entry.json),
        )
      : [];
    const existingByKey = new Map(existing.map((row) => [row.key, row]));
    const toDelete = deleteKeys.length
      ? await ctx.db.$queryRawUnsafe<{ key: string; bytes: number }[]>(
          `SELECT "key", octet_length("value"::text) AS "bytes" FROM "ItemDocEntry"
           WHERE "itemId" = $1 AND "doc" = $2 AND "key" = ANY($3::text[])`,
          itemId,
          input.doc,
          deleteKeys,
        )
      : [];

    const changes: DocKeyChange[] = [];
    const writes: { key: string; json: string }[] = [];
    for (const { key, json } of serialised) {
      const row = existingByKey.get(key);
      if (row?.exists && row.same) continue;
      writes.push({ key, json });
      changes.push({ key, op: row?.exists ? "updated" : "created", bytes: byteLength(json) });
    }
    for (const row of toDelete) {
      changes.push({ key: row.key, op: "deleted", bytes: Number(row.bytes) });
    }

    if (changes.length === 0) {
      return { itemId, doc: input.doc, rev: currentRev, changed: false, keys: [], eventId: null };
    }

    const rev = currentRev + 1;
    await ctx.db.$executeRawUnsafe(
      `UPDATE "ItemDoc" SET "rev" = $3, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "itemId" = $1 AND "doc" = $2`,
      itemId,
      input.doc,
      rev,
    );
    if (writes.length > 0) {
      await ctx.db.$executeRawUnsafe(
        `INSERT INTO "ItemDocEntry" ("itemId", "doc", "key", "value", "rev", "updatedAt", "updatedBy")
         SELECT $1::text, $2::text, s."key", s."value"::jsonb, $3::int, CURRENT_TIMESTAMP, $4::text
         FROM unnest($5::text[], $6::text[]) AS s("key", "value")
         ON CONFLICT ("itemId", "doc", "key") DO UPDATE
           SET "value" = EXCLUDED."value",
               "rev" = EXCLUDED."rev",
               "updatedAt" = EXCLUDED."updatedAt",
               "updatedBy" = EXCLUDED."updatedBy"`,
        itemId,
        input.doc,
        rev,
        ctx.caller.actor ?? ctx.caller.sessionId ?? null,
        writes.map((write) => write.key),
        writes.map((write) => write.json),
      );
    }
    if (toDelete.length > 0) {
      await ctx.db.$executeRawUnsafe(
        `DELETE FROM "ItemDocEntry" WHERE "itemId" = $1 AND "doc" = $2 AND "key" = ANY($3::text[])`,
        itemId,
        input.doc,
        toDelete.map((row) => row.key),
      );
    }

    // The event names keys and sizes. It never carries a value: that is the
    // property the ledger's readers rely on, and the one a test pins.
    const event = await appendEvent(ctx.db, {
      itemId,
      actor: callerEventActor(ctx.caller),
      assignmentId: await liveAssignmentId(ctx.db, itemId, ctx.caller),
      type: "doc_change",
      payload: { doc: input.doc, rev, previousRev: currentRev, keys: changes },
    });

    return {
      itemId,
      doc: input.doc,
      rev,
      changed: true,
      keys: changes,
      eventId: event.id.toString(),
    };
  },
});
