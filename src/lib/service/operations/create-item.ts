// `create_item` — SCHEMA.md §1, §1.1a (facets), §17.2 (`items.max_depth`,
// `items.default_merge_authority`).
//
// Depth and `kind` are derived here rather than trusted from the caller:
// `kind` is documented as "derived from depth, stored for cheap querying",
// and a caller-supplied `kind` that disagreed with `parent_id` would be
// exactly the drift that makes the stored column untrustworthy. The guard
// on `items.max_depth` runs against the *resolved* depth for the same
// reason — trusting a caller-supplied depth would make the guard
// decorative.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ensureAreaRaw } from "../items/ensure-area-raw";
import { callerEventActor } from "../items/event-attribution";
import { appendEvent } from "@/lib/events";
import {
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";

const inputSchema = z
  .object({
    title: z.string().trim().min(1, "title is required"),
    /**
     * The one-line BLUF — what this work *is* (MILESTONES.md #107).
     * Optional, because an item minted by an importer or a source sweep has
     * nobody to write one, and refusing those mints to enforce a field the
     * caller cannot supply would be worse than the field being absent.
     * Trimmed and capped, so the slim read's whole value proposition — that
     * it is small — cannot be undone by writing a brief into it.
     */
    headline: z.string().trim().min(1).max(HEADLINE_MAX_CHARS).optional(),
    body: z.string(),
    /** Null/omitted = a root project. */
    parentId: z.string().min(1).optional(),
    /** Raw area label — resolved through `ensureArea` (auto-create, normalised; SCHEMA.md §23.1). */
    area: z.string().trim().min(1, "area is required"),
    /** An existing `repos.id`. Repos are deliberate-create only (SCHEMA.md §23.1) — never auto-created here. */
    repo: z.string().min(1).optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
    originType: z.enum(["person", "source", "auto"]),
    originPersonId: z.string().min(1).optional(),
    driveMode: z.enum(["autonomous", "supervised", "manual"]).default("autonomous"),
    /** Omitted = `items.default_merge_authority` (SCHEMA.md §17.2). */
    mergeAuthority: z.enum(["pre-approved", "needs-approval", "agent-judgement"]).optional(),
    needsVisualReview: z.boolean().default(false),
    difficulty: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.originType !== "person" || value.originPersonId !== undefined, {
    message: "originPersonId is required when originType is person",
    path: ["originPersonId"],
  });

export type CreateItemInput = z.infer<typeof inputSchema>;

const MERGE_AUTHORITY_TO_DB: Record<string, "pre_approved" | "needs_approval" | "agent_judgement"> =
  {
    "pre-approved": "pre_approved",
    "needs-approval": "needs_approval",
    "agent-judgement": "agent_judgement",
  };

export const createItem = defineOperation({
  name: "create_item",
  kind: "write",
  summary: "Creates an item — a project, task or subtask, depending on its parent.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateItemInput): Promise<ItemRecord> {
    let depth = 0;
    if (input.parentId) {
      // The parent's own depth, as the number of ancestor hops to a root
      // (a row with a null `parentId`). One query answers both "does the
      // parent exist" (an empty result set) and "how deep is it" (the row
      // count), so the guard below is checked against the resolved depth
      // rather than a caller-supplied one.
      const ancestorRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `WITH RECURSIVE ancestors AS (
           SELECT "id", "parentId" FROM "Item" WHERE "id" = $1
           UNION ALL
           SELECT i."id", i."parentId"
           FROM "Item" i JOIN ancestors a ON i."id" = a."parentId"
         )
         SELECT "id" FROM ancestors`,
        input.parentId,
      );
      if (ancestorRows.length === 0) {
        throw new NotFoundError(`No such parent item: ${input.parentId}.`, {
          fields: ["parentId"],
        });
      }
      depth = ancestorRows.length;
    }

    // items.max_depth (SCHEMA.md §17.2): "A runaway guard on the item tree:
    // a create that would exceed this depth is refused rather than allowed
    // to grow without bound."
    if (depth > ctx.settings.values["items.max_depth"]) {
      throw new GuardRejectedError(
        "items.max_depth",
        `Creating this item would put it at depth ${depth}, past the configured maximum of ${ctx.settings.values["items.max_depth"]}.`,
        { fields: ["parentId"] },
      );
    }

    const kind = depth === 0 ? "project" : depth === 1 ? "task" : "subtask";

    // `ensureArea` (areas.ts) takes a Prisma client's `.area` delegate,
    // which `TransactionHandle` deliberately does not expose (context.ts —
    // an operation cannot open a second transaction through it). Resolve
    // the area with the same normalise-and-upsert semantics against this
    // transaction's own raw handle instead, so an area minted here and the
    // item that names it commit or roll back together.
    const resolvedArea = await ensureAreaRaw(ctx, input.area);

    if (input.repo) {
      const repoRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Repo" WHERE "id" = $1 AND "archivedAt" IS NULL`,
        input.repo,
      );
      if (repoRows.length === 0) {
        throw new NotFoundError(`No such repo: ${input.repo}.`, { fields: ["repo"] });
      }
    }

    if (input.originType === "person" && input.originPersonId) {
      const personRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Person" WHERE "id" = $1`,
        input.originPersonId,
      );
      if (personRows.length === 0) {
        throw new NotFoundError(`No such person: ${input.originPersonId}.`, {
          fields: ["originPersonId"],
        });
      }
    }

    const mergeAuthority =
      MERGE_AUTHORITY_TO_DB[
        input.mergeAuthority ?? ctx.settings.values["items.default_merge_authority"]
      ];

    const id = crypto.randomUUID();
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `INSERT INTO "Item" (
         "id", "parentId", "kind", "title", "headline", "body", "state", "priority",
         "originType", "originPersonId", "area", "repo", "needsVisualReview",
         "driveMode", "mergeAuthority", "difficulty", "customFields",
         "updatedAt"
       ) VALUES (
         $1, $2, $3::"ItemKind", $4, $5, $6, 'on_deck'::"ItemState", $7::"Priority",
         $8::"OriginType", $9, $10, $11, $12,
         $13::"DriveMode", $14::"MergeAuthority", $15::jsonb, $16::jsonb,
         CURRENT_TIMESTAMP
       )
       RETURNING ${ITEM_COLUMNS}`,
      id,
      input.parentId ?? null,
      kind,
      input.title,
      input.headline ?? null,
      input.body,
      input.priority,
      input.originType,
      input.originPersonId ?? null,
      resolvedArea,
      input.repo ?? null,
      input.needsVisualReview,
      input.driveMode,
      mergeAuthority,
      input.difficulty ? JSON.stringify(input.difficulty) : null,
      input.customFields ? JSON.stringify(input.customFields) : null,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError("Item insert returned no row.", { fields: [] });
    }

    // "Every mutating call appends a row" (SCHEMA.md §3). A create has no
    // prior value to diff, so it is recorded as a field-change from null —
    // the same event type an ordinary edit uses, which is what keeps
    // "when did this item come to exist" answerable from the one ledger
    // rather than a special case only creates get.
    //
    // Through `appendEvent` rather than an inline INSERT (#102): that is the
    // module's stated invariant, and it is what gets `sessionId` onto the
    // row. A five-column insert had nowhere to put it.
    //
    // No assignment lookup here, unlike the other three: the item is being
    // created by this very call, so nobody can be holding a claim on it yet.
    // Querying for one would be asking a question whose answer is known.
    await appendEvent(ctx.db, {
      itemId: row.id,
      actor: callerEventActor(ctx.caller),
      type: "field_change",
      payload: { field: "state", from: null, to: "on_deck" },
    });

    return toItemRecord(row);
  },
});
