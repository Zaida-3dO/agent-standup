// `update_item` — SCHEMA.md §19 `PATCH /items/{id}` ("Edit non-state
// fields"). Transitioning `state` is MILESTONES.md #27's own operation, not
// this one — a guarded move needs the transition guard layer (#19), which
// this row does not own, so `state` is deliberately absent from this
// operation's input schema rather than merely unchecked.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ensureAreaRaw } from "../items/ensure-area-raw";
import {
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { recordFieldChanges } from "@/lib/events";
import { evaluateNotifications, snapshotOf, type NotificationOutcome } from "../notify-on-change";

const inputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    /**
     * The one-line BLUF (MILESTONES.md #107). Editable because the row's
     * whole claim is that it is "maintained as it moves" — a headline
     * written at mint and never updated describes the work as it was
     * *proposed*, which is the least useful moment to freeze it at.
     * Nullable so it can be cleared back to "nobody has written one",
     * which is a state the read distinguishes.
     */
    headline: z.string().trim().min(1).max(HEADLINE_MAX_CHARS).nullable().optional(),
    body: z.string().optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    area: z.string().trim().min(1).optional(),
    repo: z.string().min(1).nullable().optional(),
    branch: z.string().nullable().optional(),
    needsVisualReview: z.boolean().optional(),
    driveMode: z.enum(["autonomous", "supervised", "manual"]).optional(),
    mergeAuthority: z.enum(["pre-approved", "needs-approval", "agent-judgement"]).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type UpdateItemInput = z.infer<typeof inputSchema>;

/**
 * What `update_item` returns — the item, plus who the notification rules say
 * to tell about the edit (MILESTONES.md #101).
 *
 * A widening of `ItemRecord`, not a wrapper: every existing caller reads
 * item fields straight off this result, and nesting them under a key would
 * break each one for no gain. `notifications` is absent when the capability
 * is off (`notify.doc` unset), which stays distinguishable from "on, and
 * nobody matched" — an outcome with empty `recipients`.
 */
export type UpdateItemResult = ItemRecord & {
  readonly notifications?: NotificationOutcome;
};

const MERGE_AUTHORITY_TO_DB: Record<string, "pre_approved" | "needs_approval" | "agent_judgement"> =
  {
    "pre-approved": "pre_approved",
    "needs-approval": "needs_approval",
    "agent-judgement": "agent_judgement",
  };

/** Every editable field, and how to read its current value off a raw row — for the field-change diff. */
const EDITABLE_FIELDS = [
  "title",
  "headline",
  "body",
  "priority",
  "area",
  "repo",
  "branch",
  "needsVisualReview",
  "driveMode",
  "mergeAuthority",
  "customFields",
] as const;

export const updateItem = defineOperation({
  name: "update_item",
  kind: "write",
  summary: "Edits an item's non-state fields.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateItemInput): Promise<UpdateItemResult> {
    const { id, ...rawEdits } = input;
    const edits = Object.fromEntries(
      Object.entries(rawEdits).filter(([, value]) => value !== undefined),
    ) as Partial<Omit<UpdateItemInput, "id">>;

    const currentRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      id,
    );
    const current = currentRows[0];
    if (!current) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    if (edits.area !== undefined) {
      edits.area = await ensureAreaRaw(ctx, edits.area);
    }
    if (edits.repo) {
      const repoRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Repo" WHERE "id" = $1 AND "archivedAt" IS NULL`,
        edits.repo,
      );
      if (repoRows.length === 0) {
        throw new NotFoundError(`No such repo: ${edits.repo}.`, { fields: ["repo"] });
      }
    }

    // Nothing to do: no `RETURNING` clause and no event row for a no-op
    // call, so an empty patch (or a patch whose only key already matched
    // the current value's shape, e.g. resubmitting the same title) stays
    // provably a no-op rather than adding a phantom entry to the ledger.
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;
    const changes: { field: string; from: unknown; to: unknown }[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!(field in edits)) continue;
      const rawNewValue = (edits as Record<string, unknown>)[field];
      const oldValue = (current as unknown as Record<string, unknown>)[field];
      // `mergeAuthority` is the one editable field whose API encoding
      // (hyphenated, `"needs-approval"`) differs from its stored encoding
      // (underscored, `"needs_approval"` — the Postgres enum label). Every
      // other editable field's API form and stored form are the same
      // string (SCHEMA.md §1's enums: Priority, DriveMode use identical
      // spellings on both sides). Diffing against the *stored* form here —
      // rather than the raw input — is what makes "unchanged" actually mean
      // unchanged: comparing the two encodings directly always disagrees,
      // which is what produced a phantom field_change event on every
      // mergeAuthority no-op (review round 1, MEDIUM 1).
      const newValue =
        field === "mergeAuthority" ? MERGE_AUTHORITY_TO_DB[rawNewValue as string] : rawNewValue;
      if (JSON.stringify(newValue) === JSON.stringify(oldValue)) continue;

      changes.push({ field, from: oldValue, to: newValue });

      if (field === "mergeAuthority") {
        setClauses.push(`"mergeAuthority" = $${paramIndex}::"MergeAuthority"`);
        values.push(newValue);
      } else if (field === "priority") {
        setClauses.push(`"priority" = $${paramIndex}::"Priority"`);
        values.push(newValue);
      } else if (field === "driveMode") {
        setClauses.push(`"driveMode" = $${paramIndex}::"DriveMode"`);
        values.push(newValue);
      } else if (field === "customFields") {
        setClauses.push(`"customFields" = $${paramIndex}::jsonb`);
        values.push(JSON.stringify(newValue));
      } else {
        const column = field === "needsVisualReview" ? '"needsVisualReview"' : `"${field}"`;
        setClauses.push(`${column} = $${paramIndex}`);
        values.push(newValue);
      }
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return toItemRecord(current);
    }

    setClauses.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    values.push(id);

    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `UPDATE "Item" SET ${setClauses.join(", ")} WHERE "id" = $${paramIndex} RETURNING ${ITEM_COLUMNS}`,
      ...values,
    );
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    // "Every mutating call appends a row" (SCHEMA.md §3) — one field_change
    // event per changed field, so an edit touching several fields at once
    // (e.g. re-triaging priority and area together) reads back as several
    // distinct facts rather than one payload a consumer has to unpack.
    //
    // Through `recordFieldChanges` (#102), which is that loop plus the
    // `appendEvent` call — its first caller, and the reason it was written.
    // Routing through it is what gets `sessionId` and `assignmentId` onto
    // the rows; the inline five-column insert had nowhere to put either.
    //
    // The snapshots handed to it are built from `changes`, NOT from the raw
    // input and the loaded row. That matters: `changes` already holds the
    // *stored* form of each value (`mergeAuthority` is spelled one way in
    // the API and another in the Postgres enum), and it already dropped
    // every field whose new value equals its stored value. Passing the raw
    // input instead would re-diff the two encodings against each other and
    // resurrect the phantom `mergeAuthority` field_change on a no-op that
    // this function's own loop above exists to prevent. `recordFieldChanges`
    // compares with the same `JSON.stringify` equality, so every entry here
    // is one it will agree has changed.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const change of changes) {
      before[change.field] = change.from;
      after[change.field] = change.to;
    }
    await recordFieldChanges(ctx.db, {
      itemId: id,
      actor: callerEventActor(ctx.caller),
      assignmentId: await liveAssignmentId(ctx.db, id, ctx.caller),
      before,
      after,
      fields: changes.map((change) => change.field),
    });

    const record = toItemRecord(updated);

    // The notification evaluator's caller — MILESTONES.md #101. An edit is
    // the only thing that changes four of the whitelisted fields a rule may
    // watch (`area`, `repo`, `priority`, `drive_mode`, `merge_authority`),
    // so wiring only `transition_item` would leave those rules dead.
    //
    // No event is written for the result, deliberately. The obvious shortcut
    // — appending a `note` — would be recording a notification under an
    // event type that means something else, and a `notify`/`notified` type of
    // its own is a schema change that needs its own row (SCHEMA.md §3: add an
    // event type only when the code that emits it exists). Returned instead,
    // which is what `transition_item` does with the same value.
    const notifyDoc = ctx.settings.values["notify.doc"];
    const notifications =
      notifyDoc === null
        ? undefined
        : await evaluateNotifications(
            ctx.db,
            notifyDoc,
            snapshotOf(toItemRecord(current), null),
            snapshotOf(record, null),
          );

    return notifications ? { ...record, notifications } : record;
  },
});
