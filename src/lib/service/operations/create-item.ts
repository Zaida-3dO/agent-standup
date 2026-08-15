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
import { normalizeEmDash } from "@/lib/text-normalize";
import {
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";

const inputSchema = z
  .object({
    // `.trim()` first, `normalizeEmDash` after: an em dash at the very edge
    // of the raw string ("— fix the bug") is still a title-authoring choice,
    // not whitespace, so it must survive trimming to be normalised at all.
    title: z.string().trim().min(1, "title is required").transform(normalizeEmDash),
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
    /**
     * Omitted = inherited from `repo.needsVisualReview` (MILESTONES.md #126),
     * or `false` when there is no `repo`. Left `optional()` rather than
     * `.default(false)` deliberately: a `.default()` resolves before the
     * handler ever runs, so by the time the handler could check "did the
     * caller actually say something" the answer would already be lost — the
     * exact silent-default shape #126 was filed against. An explicit
     * `false` on a `true`-repo is a real override (back-end-only work in a
     * repo that generally needs visual review), not a no-op, so the
     * resolution has to happen after this schema, not inside it.
     */
    needsVisualReview: z.boolean().optional(),
    difficulty: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.originType !== "person" || value.originPersonId !== undefined, {
    message: "originPersonId is required when originType is person",
    path: ["originPersonId"],
  });

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
 */
const contract = {
  rules: [
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
  ],
  example: {
    title: "Add a rate limit to the public endpoint",
    body: "The endpoint is unauthenticated and unbounded.",
    area: "api",
    originType: "auto",
  },
} as const;

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
  contract,
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

    // Also carries `needsVisualReview` (MILESTONES.md #126): the same
    // lookup that already exists to validate `repo` is the natural place to
    // read the value a create with no explicit `needsVisualReview` should
    // inherit — one query serves both, rather than adding a second round
    // trip purely for the inherited field.
    let repoNeedsVisualReview = false;
    if (input.repo) {
      const repoRows = await ctx.db.$queryRawUnsafe<{ id: string; needsVisualReview: boolean }[]>(
        `SELECT "id", "needsVisualReview" FROM "Repo" WHERE "id" = $1 AND "archivedAt" IS NULL`,
        input.repo,
      );
      const repoRow = repoRows[0];
      if (!repoRow) {
        throw new NotFoundError(`No such repo: ${input.repo}.`, { fields: ["repo"] });
      }
      repoNeedsVisualReview = repoRow.needsVisualReview;
    }

    // Inheritance is a default, never a lock (MILESTONES.md #126): an
    // explicit `true` or `false` from the caller always wins over whatever
    // the repo says. Only an omitted field falls through to the repo's
    // value, and to `false` when there is no repo at all.
    const needsVisualReview = input.needsVisualReview ?? repoNeedsVisualReview;

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
      needsVisualReview,
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
