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
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";

const inputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).optional(),
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

const MERGE_AUTHORITY_TO_DB: Record<string, "pre_approved" | "needs_approval" | "agent_judgement"> =
  {
    "pre-approved": "pre_approved",
    "needs-approval": "needs_approval",
    "agent-judgement": "agent_judgement",
  };

/** Every editable field, and how to read its current value off a raw row — for the field-change diff. */
const EDITABLE_FIELDS = [
  "title",
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
  async handler(ctx: ServiceContext, input: UpdateItemInput): Promise<ItemRecord> {
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
      const newValue = (edits as Record<string, unknown>)[field];
      const oldValue = (current as unknown as Record<string, unknown>)[field];
      if (JSON.stringify(newValue) === JSON.stringify(oldValue)) continue;

      changes.push({ field, from: oldValue, to: newValue });

      if (field === "mergeAuthority") {
        setClauses.push(`"mergeAuthority" = $${paramIndex}::"MergeAuthority"`);
        values.push(MERGE_AUTHORITY_TO_DB[newValue as string]);
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
    for (const change of changes) {
      await ctx.db.$executeRawUnsafe(
        `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload")
         VALUES ($1, $2::"ActorType", $3, 'field_change'::"EventType", $4::jsonb)`,
        id,
        ctx.caller.actor ? "agent" : "system",
        ctx.caller.actor ?? null,
        JSON.stringify({ field: change.field, from: change.from, to: change.to }),
      );
    }

    return toItemRecord(updated);
  },
});
