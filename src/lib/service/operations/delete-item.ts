// `delete_item` — MILESTONES.md #137, SCHEMA.md §1, §23.1's standing rule
// ("archive, never delete — attribution and history point at these rows").
//
// ── It is called delete and it never deletes ────────────────────────────
//
// Nothing leaves the database. The row stops being *served*: no ordinary
// read returns it, no column counts it, no parent derives its state from it,
// and no repair pass will move it. Three reads still reach it deliberately —
// `get_item` and `get_item_detail` by id, so a stale link lands somewhere
// real, and `get_events`, because history is not rewritten.
// Every inbound link and every attribution therefore keeps resolving, which
// is the whole reason the row is kept — an event pointing at a deleted row,
// a review deferring findings into it, a summary naming it, all still land
// somewhere real instead of at a hole.
//
// The name is the honest one for what a caller is *doing*, not for what the
// storage does. A caller reaching for this has decided a row should not
// exist; "delete" is that decision's name, and offering only "archive" would
// invite the reasonable-sounding reading that archiving is a filing step
// something else follows. The mechanism is stated plainly to anyone who
// looks — this comment, the operation's own summary, the response's
// `archivedAt` — and hidden from nobody. What it does not do is make the
// caller think about storage in order to say what they mean.
//
// ── Why it exists at all, given `cancelled` ─────────────────────────────
//
// A cancellation is a real outcome: work that was wanted, considered, and
// deliberately not done. It belongs in the record, and it correctly still
// shows up in reads that ask for terminal work.
//
// A duplicate is not that. Neither is a row created by accident. Cancelling
// one records a decision nobody made and leaves the board narrating a choice
// that never happened — the record becomes *wrong* rather than merely
// cluttered. That is the narrow gap this fills: rows that should never have
// existed, for which every available terminal state is a false statement
// about history.
//
// ── The discouragement is structural, not advisory ──────────────────────
//
// Overwhelmingly, a caller reaching for this wants `cancelled` and has
// reached past it. Documentation saying so would be read by the callers who
// least need it, so the steering is built into the refusals instead:
//
//   - **A reason is required**, and a reason short enough to be a shrug is
//     refused. Naming why costs a sentence, and writing that sentence is
//     where "I decided not to do this" usually surfaces as the real answer.
//   - **Reasons that describe a cancellation are refused by name**, with
//     `cancel` named as the call to make instead. This is the one that
//     actually fires: the mistake is not malice, it is reaching for the
//     nearest verb, and a refusal that names the right verb converts the
//     attempt rather than merely blocking it.
//   - **Inbound references are surfaced before the archive proceeds**, never
//     silently orphaned — "if another task is pointing at this task that
//     might be a problem". A caller that has not looked is told what is
//     pointing at the row and has to say it meant it.
//
// ── Why it is exposed on every surface, including MCP ───────────────────
//
// Withholding it from MCP was considered — an agent tidying its own mess is
// precisely the caller this should be hardest for — and is not available.
// §22 bounds waivers: no adapter exposing any write may waive an operation a
// guard can reject, so that an adapter cannot decline exactly the operations
// that are hard to get right and then satisfy the conformance assertions
// vacuously. This operation refuses in four distinct ways, which is the
// clearest possible case of an operation §22 means to keep on every surface.
//
// That bound is the better answer anyway. A surface-shaped restriction
// protects nothing it claims to: the same agent holds a command line and an
// HTTP client, so hiding one door relocates the call rather than preventing
// it, while costing the property that every adapter refuses identically. The
// restrictions that survive being routed around are the ones in the refusals
// above, and those apply wherever the call arrives from.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent } from "@/lib/events";
import { callerEventActor } from "../items/event-attribution";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";

/**
 * The shortest reason accepted.
 *
 * Long enough that "dupe", "oops" and "wrong" do not clear it, short enough
 * that "duplicate of the auth refactor task" does. The point is not the
 * character count — it is that a caller has to name *which* accident, which
 * is the sentence that makes a mistaken archive reviewable later and the
 * sentence during which a caller often notices they meant `cancel`.
 */
export const ARCHIVE_REASON_MIN_CHARS = 20;

/** The guard id a reason-shaped refusal carries, so a caller can match on it rather than on prose. */
export const ARCHIVE_REASON_GUARD = "items.archive_reason_is_not_a_cancellation";

/** The guard id an unacknowledged-inbound-reference refusal carries. */
export const ARCHIVE_REFERENCES_GUARD = "items.archive_has_inbound_references";

/**
 * Reason wordings that describe a cancellation rather than an archive.
 *
 * The distinction being enforced is the owner's own: *"typically it's — I
 * had this task, I wanted to do it, I decided not to. That's cancel, not
 * archive."* An archive is for a row that should never have existed; every
 * phrase here describes a row that legitimately existed and whose work was
 * then dropped.
 *
 * Deliberately a small list of decisive phrases rather than a broad one. A
 * false positive here is expensive — it refuses a caller who is right, and
 * the only way past is to reword a reason that was already accurate, which
 * teaches the caller to write worse reasons to satisfy a matcher. So these
 * are phrases that essentially cannot appear in an honest archive reason,
 * and the list is allowed to miss cases: the check is a nudge at the moment
 * of the mistake, not a proof of correctness.
 */
const CANCELLATION_PHRASES = [
  "decided not to",
  // external-ref-ok-next-line: this is a phrase the matcher searches reasons for, not prose about this repository
  "no longer needed",
  "not doing this",
  "not going to do",
  "changed our mind",
  "changed my mind",
  "out of scope",
  "deprioriti", // deprioritised / deprioritized / deprioritising
  "won't do",
  "wont do",
  "not worth doing",
] as const;

const inputSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Why this row should not exist. Required, and checked for length and
     * for cancellation wording — see the module header for why the
     * requirement is the operation's main line of defence.
     */
    reason: z.string().trim().min(1, "reason is required"),
    /**
     * The item this one is being archived in favour of — most often the
     * surviving half of a duplicate.
     *
     * Optional, because not every accidental row has a replacement, and
     * requiring one would push callers into naming an unrelated item to
     * satisfy the field. Strongly wanted when there is one: *"high chance
     * the task has been replaced with something else"*, and a reader who
     * arrives at this row by a stale link can then be sent somewhere live.
     */
    supersededById: z.string().min(1).optional(),
    /**
     * Acknowledges the inbound references this call would otherwise be
     * refused for.
     *
     * The default refusal is what surfaces them: a caller who has not looked
     * gets told exactly what points at this row, and passing this flag is
     * how they say they looked and meant it. Making it a second call rather
     * than a warning in the response is the point — a warning attached to a
     * completed archive is read after the row is already invisible.
     */
    acknowledgeReferences: z.boolean().default(false),
  })
  .strict();

export type DeleteItemInput = z.infer<typeof inputSchema>;

/** What points at an item, as the refusal reports it. */
export interface InboundReference {
  /** What kind of thing is pointing here. */
  readonly kind: "child" | "follow_up_artifact" | "superseded_by" | "live_claim";
  /** The pointing row's id. */
  readonly id: string;
  /** Enough to recognise it without a second read. */
  readonly detail: string;
}

/**
 * Everything pointing at this item, in one read per relationship.
 *
 * Only relationships where something *live* depends on this row remaining
 * visible are counted. Events, summaries and *released* assignments all
 * point here too and are deliberately absent: they are history about this
 * row, they resolve fine against an archived one, and listing them would
 * make every archive report references — which would train callers to pass
 * `acknowledgeReferences` reflexively and turn the refusal into a formality.
 */
async function inboundReferences(ctx: ServiceContext, itemId: string): Promise<InboundReference[]> {
  const references: InboundReference[] = [];

  // Children. The sharpest case: archiving a parent takes its subtree out of
  // the detail view with it, so live children would become unreachable
  // through the tree that is how anyone navigates to them.
  const childRows = await ctx.db.$queryRawUnsafe<{ id: string; title: string; state: string }[]>(
    `SELECT "id", "title", "state" FROM "Item"
     WHERE "parentId" = $1 AND "archivedAt" IS NULL
     ORDER BY "createdAt" ASC, "id" ASC`,
    itemId,
  );
  for (const row of childRows) {
    references.push({
      kind: "child",
      id: row.id,
      detail: `${row.title} (${row.state})`,
    });
  }

  // Reviews that deferred their findings into this item — `Artifact.
  // followUpItemId`. A review that said "this is fine, the rest is tracked
  // over there" is relying on "over there" existing.
  const followUpRows = await ctx.db.$queryRawUnsafe<{ id: string; itemId: string }[]>(
    `SELECT "id", "itemId" FROM "Artifact" WHERE "followUpItemId" = $1`,
    itemId,
  );
  for (const row of followUpRows) {
    references.push({
      kind: "follow_up_artifact",
      id: row.id,
      detail: `a review on item ${row.itemId} deferred findings into this item`,
    });
  }

  // Sessions still holding this item. A claim is not released here — it is
  // a record of who took the row, and rewriting it to tidy up would falsify
  // that history — so the honest treatment is to make the holder visible
  // before the row goes quiet underneath them, rather than after. Somebody
  // is working on this right now is also the single strongest signal that
  // "this should never have existed" is the wrong call.
  const claimRows = await ctx.db.$queryRawUnsafe<{ id: string; holderId: string }[]>(
    `SELECT "id", "holderId" FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
    itemId,
  );
  for (const row of claimRows) {
    references.push({
      kind: "live_claim",
      id: row.id,
      detail: `${row.holderId} is holding this item`,
    });
  }

  // Items already archived in favour of this one. Archiving the survivor
  // would leave those rows pointing at something equally invisible, which
  // defeats the reason the pointer is recorded at all.
  const supersededRows = await ctx.db.$queryRawUnsafe<{ id: string; title: string }[]>(
    `SELECT "id", "title" FROM "Item" WHERE "supersededById" = $1`,
    itemId,
  );
  for (const row of supersededRows) {
    references.push({
      kind: "superseded_by",
      id: row.id,
      detail: `${row.title} was archived in favour of this item`,
    });
  }

  return references;
}

/**
 * The cancellation phrase a reason contains, if any.
 *
 * Exported so the refusal's wording and a direct unit test can both be
 * driven without a database — the check is pure text and deserves to be
 * testable as pure text.
 */
export function cancellationPhraseIn(reason: string): string | undefined {
  const haystack = reason.toLowerCase();
  return CANCELLATION_PHRASES.find((phrase) => haystack.includes(phrase));
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const deleteItem = defineOperation({
  name: "delete_item",
  kind: "write",
  summary:
    "Removes an item from every read, for rows that should never have existed — a duplicate, or one created by accident. Requires a reason, and prefers supersededById naming the item this one was replaced by. Use transition_item to cancelled instead for work that was real and is not being done; that is almost always the right call.",
  contract: {
    rules: [
      {
        fields: ["reason"],
        rule: `A reason is required, must be at least ${ARCHIVE_REASON_MIN_CHARS} characters, and must not describe a cancellation — work that was wanted and then dropped is cancelled through transition_item, not removed here.`,
      },
      {
        fields: ["acknowledgeReferences"],
        rule: "An item with live children, a session still holding it, or a review that deferred findings into it, is refused until acknowledgeReferences is true. The refusal lists what points at it.",
      },
      {
        fields: ["supersededById"],
        rule: "Must name an existing item, and cannot be the item being removed. Supply it whenever there is a surviving replacement.",
      },
    ],
    example: {
      id: "01J000000000000000000000",
      reason: "duplicate of the session-registration task, created twice by the same sweep",
      supersededById: "01J111111111111111111111",
    },
  },
  // Stryker restore all
  input: inputSchema,
  // Returns the FULL `ItemRecord`, deliberately — the one write here that
  // does not slim to `ItemWriteRecord`. That shape exists because a write's
  // response is a receipt for a row the caller can read again whenever it
  // likes, so shipping `body` and `customFields` back is waste.
  //
  // This call weakens that premise rather than inverting it. The row is NOT
  // unreadable afterwards: this archives (`archivedAt`), and `get_item`
  // applies no archived filter, so a later read still returns it — see
  // `tests/item-archive.test.ts`, "is still reachable by get_item, which is
  // how a stale link resolves". What changes is that the row leaves every
  // LISTING read, so a caller holding only a board or search result has no
  // route back to `body` and `customFields` without already knowing the id.
  // The full record is the response's value for that caller, not padding.
  async handler(ctx: ServiceContext, input: DeleteItemInput): Promise<ItemRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }

    // Already archived. Reported as done rather than refused: the caller
    // asked for a state the row is in, and a second archive would only
    // overwrite the original reason — losing the record of why it first
    // happened in exchange for nothing.
    if (row.archivedAt !== null) {
      return toItemRecord(row);
    }

    if (input.reason.length < ARCHIVE_REASON_MIN_CHARS) {
      throw new GuardRejectedError(
        ARCHIVE_REASON_GUARD,
        `A reason of at least ${ARCHIVE_REASON_MIN_CHARS} characters is required — name which duplicate or which accident, so this stays reviewable. If the work was real and is simply not being done, transition_item to cancelled instead.`,
        { fields: ["reason"] },
      );
    }

    const phrase = cancellationPhraseIn(input.reason);
    if (phrase !== undefined) {
      throw new GuardRejectedError(
        ARCHIVE_REASON_GUARD,
        `That reason ("${phrase}") describes a cancellation, not a row that should never have existed. Work that was wanted and then dropped is a real outcome and belongs in the record — transition_item to cancelled. Remove an item only when it is a duplicate or was created by accident.`,
        { fields: ["reason"] },
      );
    }

    if (input.supersededById !== undefined) {
      if (input.supersededById === input.id) {
        throw new GuardRejectedError(
          ARCHIVE_REASON_GUARD,
          "An item cannot be superseded by itself — supersededById names the item that survives.",
          { fields: ["supersededById"] },
        );
      }
      const replacementRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Item" WHERE "id" = $1`,
        input.supersededById,
      );
      if (replacementRows.length === 0) {
        throw new NotFoundError(`No such item: ${input.supersededById}.`, {
          fields: ["supersededById"],
        });
      }
    }

    const references = await inboundReferences(ctx, input.id);
    if (references.length > 0 && !input.acknowledgeReferences) {
      throw new GuardRejectedError(
        ARCHIVE_REFERENCES_GUARD,
        `${references.length} thing${references.length === 1 ? "" : "s"} point at this item and would be left pointing at something no read returns: ${references
          .map((reference) => `${reference.kind} ${reference.id} — ${reference.detail}`)
          .join(
            "; ",
          )}. Move or resolve them first, or pass acknowledgeReferences to proceed anyway.`,
        { fields: ["acknowledgeReferences"], details: { references } },
      );
    }

    const updatedRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `UPDATE "Item"
       SET "archivedAt" = CURRENT_TIMESTAMP, "archivedReason" = $2, "supersededById" = $3
       WHERE "id" = $1
       RETURNING ${ITEM_COLUMNS}`,
      input.id,
      input.reason,
      input.supersededById ?? null,
    );
    const updated = updatedRows[0];
    if (!updated) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }

    // "Every mutating call appends a row" (SCHEMA.md §3), and this one has
    // to append the *most* legible row of any: it is the event explaining
    // why a row went quiet. Recorded as a `field_change` on `archivedAt`
    // rather than a type of its own, so the one ledger a reader already
    // walks carries it — and the reason travels in the payload, where a
    // reader who found this item by an old link can see it without a
    // second read.
    //
    // The event is written against the archived item, which is the only
    // place it belongs, and events are readable for an archived item by
    // design: the row is withheld from item reads, not erased from history.
    await appendEvent(ctx.db, {
      itemId: input.id,
      actor: callerEventActor(ctx.caller),
      type: "field_change",
      body: input.reason,
      payload: {
        field: "archivedAt",
        from: null,
        to: "archived",
        reason: input.reason,
        supersededById: input.supersededById ?? null,
        acknowledgedReferences: references.map((reference) => reference.id),
      },
    });

    return toItemRecord(updated);
  },
});
