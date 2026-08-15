// The shared body behind `create_project`, `create_task` and
// `create_subtask` — SCHEMA.md §1, §1.1a (facets), §17.2 (`items.max_depth`,
// `items.default_merge_authority`, `items.inbox_project`).
//
// **Why three operations over one shared core, rather than one operation
// with a parent pointer.** `kind` is derived from depth and stored, so the
// kind an item ends up with is a *consequence* of which parent was named.
// When that is the only way to say it, a caller cannot state the thing it
// actually knows — "I want a task" — and the mismatch does not surface at
// the create at all: it surfaces several calls later, when the state machine
// refuses to transition what turned out to be a project (DECISIONS.md §13c,
// `state-machine/transition.ts`'s `ProjectHasNoStateError`). Naming the kind
// in the operation moves that refusal to the moment the choice is made, and
// costs nothing in correctness: depth is still resolved from the database
// and `kind` is still derived from it here, never trusted from the caller.
// The three operations differ only in which parent they take and what depth
// they then require; everything else — validation, area resolution, the
// insert, the event — is this module, once.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import type { ServiceContext } from "../context";
import { ensureAreaRaw } from "./ensure-area-raw";
import { callerEventActor } from "./event-attribution";
import { appendEvent } from "@/lib/events";
import { normalizeEmDash } from "@/lib/text-normalize";
import {
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "./row";

/**
 * Every field a create takes that is not the parent.
 *
 * Written as a bare shape rather than a `z.object` so each operation can
 * extend it with its own parent field and apply `.strict()` itself —
 * `.strict()` on an already-built object is not inherited by an `.extend()`
 * of it in a way that keeps the refusal message stable, and the parent field
 * differs per operation by name, requiredness and meaning.
 */
export const commonCreateShape = {
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
   * resolution has to happen after this schema, not inside it — see
   * `insertItem` below, which is where every creation path resolves it.
   */
  needsVisualReview: z.boolean().optional(),
  difficulty: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
} as const;

/**
 * The cross-field rule every create shares: a person origin names a person.
 *
 * Exported as a check plus its options rather than as a pre-refined object
 * so each operation applies it *after* adding its own parent field. Refining
 * first and extending afterwards is not available — `.refine()` returns a
 * `ZodEffects`, which has no `.extend()` — and the ordering matters for more
 * than convenience: `.strict()` has to sit on the object that already has
 * every field, or the operation's own parent field is the unrecognised key.
 */
export const originPersonCheck = (value: {
  originType: string;
  originPersonId?: string;
}): boolean => value.originType !== "person" || value.originPersonId !== undefined;

/** The message and field path `originPersonCheck` fails with. */
export const originPersonMessage = {
  message: "originPersonId is required when originType is person",
  path: ["originPersonId"],
};

/** The parsed common fields, as every create operation's handler receives them. */
export type CommonCreateInput = z.infer<z.ZodObject<typeof commonCreateShape>>;

const MERGE_AUTHORITY_TO_DB: Record<string, "pre_approved" | "needs_approval" | "agent_judgement"> =
  {
    "pre-approved": "pre_approved",
    "needs-approval": "needs_approval",
    "agent-judgement": "agent_judgement",
  };

/**
 * The parent's depth, as the number of ancestor hops to a root.
 *
 * One query answers both "does the parent exist" (an empty result set) and
 * "how deep is it" (the row count), so the depth guard below is checked
 * against a resolved depth rather than a caller-supplied one — trusting a
 * caller's depth would make the guard decorative.
 *
 * Returns `undefined` when no row with that id exists, which every caller
 * turns into its own `not_found` naming its own field: `create_task` blames
 * `projectId`, `create_subtask` blames `taskId`. A shared throw here would
 * name a field the caller never sent.
 */
export async function ancestorDepthOf(
  ctx: ServiceContext,
  parentId: string,
): Promise<number | undefined> {
  const ancestorRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `WITH RECURSIVE ancestors AS (
       SELECT "id", "parentId" FROM "Item" WHERE "id" = $1
       UNION ALL
       SELECT i."id", i."parentId"
       FROM "Item" i JOIN ancestors a ON i."id" = a."parentId"
     )
     SELECT "id" FROM ancestors`,
    parentId,
  );
  return ancestorRows.length === 0 ? undefined : ancestorRows.length;
}

/** The kind stored for an item at `depth` — SCHEMA.md §1's "derived from depth". */
export function kindForDepth(depth: number): "project" | "task" | "subtask" {
  return depth === 0 ? "project" : depth === 1 ? "task" : "subtask";
}

/**
 * Inserts the item and appends its create event.
 *
 * `parentId` and the depth it resolved to arrive already validated by the
 * operation that called this — each of the three has a different thing to
 * say about a parent that is missing or at the wrong depth, and saying it in
 * the caller is what lets the message name the field the caller actually
 * sent.
 */
export async function insertItem(
  ctx: ServiceContext,
  input: CommonCreateInput,
  parent: { id: string | null; depth: number },
): Promise<ItemRecord> {
  // items.max_depth (SCHEMA.md §17.2): "A runaway guard on the item tree:
  // a create that would exceed this depth is refused rather than allowed
  // to grow without bound."
  if (parent.depth > ctx.settings.values["items.max_depth"]) {
    throw new GuardRejectedError(
      "items.max_depth",
      `Creating this item would put it at depth ${parent.depth}, past the configured maximum of ${ctx.settings.values["items.max_depth"]}.`,
      { fields: ["parentId"] },
    );
  }

  const kind = kindForDepth(parent.depth);

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
    parent.id,
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
}
