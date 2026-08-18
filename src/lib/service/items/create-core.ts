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
import { resolveAreasRaw, setItemAreas } from "./item-areas";
import { callerEventActor } from "./event-attribution";
import { appendEvent } from "@/lib/events";
import { normalizeEmDash } from "@/lib/text-normalize";
import { titleAdviceFor, TITLE_CONVENTION_RULE } from "@/lib/item-title";
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
  /**
   * The area this item belongs to — a raw label, resolved through
   * `ensureAreaRaw` (auto-create, normalised; SCHEMA.md §23.1).
   *
   * `area` and `areas` are the same field in two spellings. One area is the
   * overwhelmingly common case, so making every caller wrap a single label
   * in a list would be friction with no benefit; an item that genuinely
   * spans several says so with `areas`. **Exactly one of the two is
   * required.** Supplying both is refused rather than resolved by
   * precedence, so a caller that sets them to different values finds out
   * instead of silently getting whichever the implementation happened to
   * prefer.
   */
  area: z.string().trim().min(1).optional(),
  /** Every area this item belongs to, **primary first** — see `area`. */
  areas: z.array(z.string().trim().min(1)).min(1).optional(),
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

/**
 * The other cross-field rule every create shares: exactly one of `area` and
 * `areas` (see `commonCreateShape.area`).
 *
 * A check rather than a `z.union` of two object shapes, for the same reason
 * `originPersonCheck` is one: each operation adds its own parent field and
 * applies `.strict()` itself, and a union would have to be rebuilt per
 * operation rather than extended. `!==` over the two `undefined` tests is
 * exclusive-or written plainly — it refuses neither-supplied and
 * both-supplied with the one expression.
 */
export const areaSpellingCheck = (value: { area?: string; areas?: string[] }): boolean =>
  (value.area === undefined) !== (value.areas === undefined);

/** The message and field path `areaSpellingCheck` fails with. */
export const areaSpellingMessage = {
  message: "exactly one of area or areas is required",
  path: ["areas"],
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
 * The title convention as a contract rule, shared by every create (#131).
 *
 * One constant rather than the same sentence written into four operations,
 * for the reason `complete_item`'s contract interpolates its caps instead of
 * retyping them: a rule that exists in four places is a rule three of them
 * will eventually disagree about, and the disagreement is silent because
 * nothing fails when documentation is wrong.
 *
 * The prose itself comes from `item-title.ts`, beside the check that applies
 * it — so the convention a caller reads and the convention the server acts on
 * are the same string.
 */
export const TITLE_CONVENTION_CONTRACT_RULE = {
  fields: ["title"],
  rule: TITLE_CONVENTION_RULE,
} as const;

/**
 * A created item, plus anything the create resolved that the caller did not
 * state (MILESTONES.md #126's third part, generalised).
 *
 * A distinct type from `ItemRecord` rather than a widening of it, because
 * the extra field is true of *this call* and not of the row: re-read the item
 * tomorrow and there is no advice, because nothing was authored. Putting it
 * on `ItemRecord` would oblige every read on every surface to carry a key
 * that is always absent, and would invite a reader to treat it as stored
 * state.
 */
export interface CreatedItem extends ItemRecord {
  /**
   * A note on the title, when it departs from the convention (#131).
   *
   * Absent when there is nothing to say. Advisory in full: the item is
   * created either way, and nothing downstream reads this.
   */
  readonly titleAdvice?: string;
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
): Promise<CreatedItem> {
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
  // the areas with the same normalise-and-upsert semantics against this
  // transaction's own raw handle instead, so an area minted here and the
  // item that names it commit or roll back together.
  //
  // Resolved before the insert so the whole call fails without writing an
  // item when an area is unusable (a label that normalises to empty).
  // `input.areas ?? [input.area]` is safe against neither being supplied
  // because `areaSpellingCheck` has already refused that case — and if it
  // somehow reached here, `resolveAreasRaw` refuses an empty list rather
  // than inventing an area.
  const resolvedAreas = await resolveAreasRaw(ctx, input.areas ?? (input.area ? [input.area] : []));
  const resolvedArea = resolvedAreas[0]!;

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

  // The full area set, written by the one function that owns both
  // representations. `Item.area` above already holds the primary; this
  // records every area including that one, so the join table is the
  // complete set rather than "the extras" — a reader never has to union
  // the two to get the answer.
  //
  // `row.areas` is patched rather than re-selected: the `ITEM_COLUMNS`
  // subquery ran as part of the INSERT ... RETURNING above, before these
  // rows existed, so the value it returned is the pre-write fallback. The
  // set just written is what this call created, by definition.
  await setItemAreas(ctx, row.id, resolvedAreas);
  row.areas = resolvedAreas;

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

  // The title convention (MILESTONES.md #131), answered on the way out.
  //
  // Attached to a create that **succeeded** rather than refusing one: the
  // convention is a matter of authorship, and `item-title.ts` carries the
  // full argument for why no predicate can decide it for every string. The
  // note reaches the one caller positioned to act on it, at the one moment
  // the title is cheap to change — a create's response, before anything
  // links to the item.
  //
  // Spread conditionally so an item whose title is already fine carries no
  // key at all, rather than a `null` every read of every create has to
  // explain. Same posture as `example` on a tool contract: absent is a
  // cleaner "nothing to say" than a present empty value.
  const record = toItemRecord(row);
  const advice = titleAdviceFor(record.title);
  return advice === null ? record : { ...record, titleAdvice: advice };
}
