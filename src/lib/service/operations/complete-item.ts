// `complete` — SCHEMA.md §18 ("Finish an item. Separate from `transition` on
// purpose — the required summary shape is in this tool's schema, where the
// agent can see it."), §19 (no dedicated HTTP row of its own beyond the one
// implied by §18 — this row adds `POST /items/{id}/complete`), §5, §5a.
// See MILESTONES.md #27.
//
// This is `transition_item` specialised to "enter a completed state, and
// persist the summary that made it valid" — the one write `applyTransition`
// (row #15) does not itself own: `evaluate()`'s guard pass reads
// `fields.summary` to decide whether a completed state may be entered
// (`summaryRequiredGuard`, `guards/summaries.ts`) but never writes a
// `Summary` row, the same way it validates but never persists
// `blocked_reason`/`pause_reason` — row #16 added that write path for those
// two fields specifically; this operation is this row's equivalent write
// path for `summaries`.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
import { applyTransition } from "../state-machine/transition";
import {
  NOT_DONE_MAX,
  NOT_DONE_MIN,
  NOT_DONE_REASONS,
  SHIPPED_CHAR_CAP,
  SHIPPED_MAX,
  SHIPPED_MIN,
  SIMILARITY_REJECT_AT,
  WHAT_TO_TEST_MAX,
  WHAT_TO_TEST_MIN,
  validateSummaryShape,
  type NotDoneEntry,
  type SummaryCandidate,
  type WhatToTestEntry,
} from "../summaries/validate";
// `findSimilarityIssues` lives alongside the guard itself
// (`guards/summaries.ts`, not `summaries/validate.ts`) — see that file's own
// header for why: it needs to be covered by the guard-registration
// canonicalisation sweep, which only scans `guards/`.
import { findSimilarityIssues } from "../guards/summaries";
// The single implementation of SCHEMA.md §5a's per-entry proof, shared with
// `deferralFollowUpGuard` — see `checkNotDoneProofs` below for why this is
// imported rather than reimplemented.
import { findNotDoneProofIssues } from "../guards/deferral";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { appendEvent } from "@/lib/events";

/** The four states a `complete` call may land on (SCHEMA.md §1.1's "Completed" column). */
const COMPLETED_STATES = ["merged", "research_done", "wont_do", "cancelled"] as const;

const notDoneEntrySchema = z
  .object({
    text: z.string(),
    // Derived from `NOT_DONE_REASONS`, not written out again: the closed set
    // is declared once in `summaries/validate.ts` (its own header — "the one
    // place the closed set is declared"), and a second literal list here
    // would be free to fall behind it, refusing at the schema boundary a
    // reason the validator and the guard both accept.
    reason: z.enum(NOT_DONE_REASONS),
    item_id: z.string().min(1).optional(),
  })
  .strict();

const whatToTestEntrySchema = z.object({ text: z.string(), link: z.string().optional() }).strict();

const summarySchema = z
  .object({
    shipped: z.array(z.string()),
    not_done: z.array(notDoneEntrySchema),
    user_facing: z.boolean(),
    what_to_test: z.array(whatToTestEntrySchema).nullable().optional(),
    how_verified: z.string().nullable().optional(),
    watch_for: z.array(z.string()),
  })
  .strict();

const inputSchema = z
  .object({
    id: z.string().min(1),
    to: z.enum(COMPLETED_STATES),
    summary: summarySchema,
    /**
     * Extra fields other guards on this `(from, to)` pair need — e.g.
     * `commit_sha` and the approving-review artifacts `merged` requires
     * (SCHEMA.md §16). Merged with `summary` before being handed to the
     * guard layer; a caller cannot use this to smuggle a second `summary`
     * key past the dedicated field above.
     */
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.fields === undefined || !("summary" in value.fields), {
    message: "fields.summary is not allowed — pass the summary in the top-level summary field.",
    path: ["fields", "summary"],
  });

export type CompleteItemInput = z.infer<typeof inputSchema>;

/**
 * The conditional matrix (MILESTONES.md #111) — every rule above that no
 * schema states.
 *
 * `summary`'s Zod shape says `shipped` is an array of strings and stops
 * there. That it must hold between one and five entries, that
 * `what_to_test` is required exactly when `user_facing` is true and
 * `how_verified` exactly when it is false, and that an entry too similar to
 * the item's own history is rejected — all of that is `validateSummaryShape`
 * and `findSimilarityIssues`, which run at call time and are invisible to a
 * client reading the schema.
 *
 * **The numbers are interpolated from the constants the validator reads**,
 * not retyped. A cap raised in `summaries/validate.ts` and left stale in a
 * sentence here would be worse than no sentence: a caller would satisfy the
 * documentation and still be refused, which is precisely the round trip this
 * row exists to remove.
 */
const contract = {
  rules: [
    {
      fields: ["summary.shipped"],
      rule:
        `\`shipped\` must hold ${SHIPPED_MIN}–${SHIPPED_MAX} entries of at most ` +
        `${SHIPPED_CHAR_CAP} characters each. The schema says only "array of strings"; the ` +
        `cardinality is checked at call time.`,
    },
    {
      fields: ["summary.what_to_test", "summary.user_facing"],
      rule:
        `\`what_to_test\` is required when \`user_facing\` is true — ${WHAT_TO_TEST_MIN}–` +
        `${WHAT_TO_TEST_MAX} entries — and must be omitted or null when it is false.`,
    },
    {
      fields: ["summary.how_verified", "summary.user_facing"],
      rule:
        "`how_verified` is required when `user_facing` is **false**, and says what was run and " +
        "observed. This is the opposite condition to `what_to_test`: exactly one of the two " +
        "applies to any given completion, decided by `user_facing`.",
    },
    {
      fields: ["summary.not_done"],
      rule:
        `\`not_done\` holds ${NOT_DONE_MIN}–${NOT_DONE_MAX} typed entries. Every reason except ` +
        `\`descoped\` requires an \`item_id\` naming a real item, and that item's state has to ` +
        `bear the reason out. \`follow-up\` says the work is stuck, so its target must be ` +
        `blocked or paused. \`follow-up-scheduled\` says the opposite — the work is not ` +
        `deferred but committed to as its own queue row — so its target must be open and a ` +
        `sibling rather than a descendant of the item being completed. \`needs-approval\` ` +
        `requires a target blocked on a person. \`descoped\` needs no linked item.`,
    },
    {
      fields: ["summary.shipped", "summary.watch_for", "summary.not_done"],
      rule:
        `Entries are rejected, never truncated, and an entry at least ` +
        `${Math.round(SIMILARITY_REJECT_AT * 100)}% similar to something already in this item's ` +
        `own history is refused. Internal vocabulary — raw field names, review shorthand — is ` +
        `also refused: a summary is written for a reader of the work, not of the system.`,
    },
    {
      fields: ["fields", "summary"],
      rule:
        "`fields` carries extras other guards on this transition need (a `commit_sha`, for " +
        "instance). It may not contain `summary` — pass that in the top-level `summary` field.",
    },
    {
      fields: ["to"],
      rule:
        `\`to\` must be one of the completed states (${COMPLETED_STATES.join(", ")}), and the ` +
        `transition's own guards still apply on top of the summary: completing to \`merged\` ` +
        `additionally needs the merge evidence that state requires.`,
    },
  ],
  example: {
    id: "<item id>",
    to: "merged",
    summary: {
      shipped: ["Rate limit added to the public endpoint"],
      not_done: [],
      user_facing: false,
      how_verified:
        "Ran the suite and drove the endpoint past the limit; the 61st call was refused.",
      watch_for: [],
    },
  },
} as const;

export interface CompleteItemResult {
  readonly item: ItemRecord;
}

function toCandidate(summary: CompleteItemInput["summary"]): SummaryCandidate {
  return {
    shipped: summary.shipped,
    not_done: summary.not_done as readonly NotDoneEntry[],
    user_facing: summary.user_facing,
    what_to_test: (summary.what_to_test ?? null) as readonly WhatToTestEntry[] | null,
    how_verified: summary.how_verified ?? null,
    watch_for: summary.watch_for,
  };
}

/**
 * Checks SCHEMA.md §5a's per-entry proof for every `not_done` reason that
 * requires a linked item, by delegating to the single implementation in
 * `guards/deferral.ts`.
 *
 * **A thin wrapper, deliberately, rather than a second copy of the rule.**
 * This check and `deferralFollowUpGuard` answer the same question at two
 * points on one call — here, up front, so a caller sees every problem in one
 * rejection round, and again inside `applyTransition`, where it is what
 * actually gates. When the two were written separately they drifted: this one
 * accepted a `merged`/`wont_do`/`cancelled` linked item as proof of a
 * `follow-up` while the guard accepted only `blocked`/`paused`, so a summary
 * pointing at a closed item passed the up-front check and was then refused by
 * the guard — the caller having been told it was fine moments earlier. One
 * implementation cannot do that, whichever way a future edit goes.
 *
 * This remains the one piece of §5a's validator surface that
 * `validateSummaryShape` (pure, no database) cannot check on its own — it
 * needs to read the linked item's current row, the same split
 * `findSimilarityIssues` already draws for the other database-dependent check.
 */
async function checkNotDoneProofs(
  ctx: ServiceContext,
  itemId: string,
  notDone: CompleteItemInput["summary"]["not_done"],
): Promise<{ field: string; message: string }[]> {
  return findNotDoneProofIssues(ctx.db, itemId, notDone as readonly NotDoneEntry[]);
}

/**
 * The `final_state` value for this completion — derived from the item's own
 * artifacts, never authored by the caller (SCHEMA.md §5, "derived, never
 * authored").
 *
 * Records that an inspection of already-merged code is part of this item's
 * evidence: `closed_on` is `historical_verification` when such an artifact
 * exists, alongside the commit it was checked against.
 *
 * **Deliberately "an inspection was recorded", not "the merge rested on
 * one".** Which clause a guard was ultimately satisfied by is not a fact the
 * item carries — the gate is a conjunction evaluated at transition time, and
 * an item can hold both a verification and an approving review. Reporting the
 * weaker provenance whenever an inspection exists errs toward disclosure: the
 * failure it must not have is an inspection-closed item that reads as
 * review-closed, and over-reporting cannot produce that. Under-reporting
 * could. The two are genuinely
 * different claims (SCHEMA.md §6b), and the value of keeping them distinct
 * evaporates if the distinction is only visible to a guard: this puts it on
 * the closing record a person actually reads, alongside the commit it was
 * checked against.
 *
 * Returns `{}` for a completion that is not a merge — `wont_do`,
 * `cancelled` and `research_done` never went through the merge gate, so
 * there is no gate-satisfaction to describe and inventing a `closed_on` for
 * them would assert something about a path they did not take.
 */
async function deriveFinalState(
  ctx: ServiceContext,
  itemId: string,
): Promise<Record<string, unknown>> {
  const rows = await ctx.db.$queryRawUnsafe<{ commitSha: string | null }[]>(
    `SELECT "commitSha"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = 'historical_verification'::"ArtifactKind"
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1`,
    itemId,
  );
  const verification = rows[0];
  if (!verification) return {};
  return {
    closed_on: "historical_verification",
    verified_at_commit: verification.commitSha,
  };
}

async function loadItemRecord(ctx: ServiceContext, id: string): Promise<ItemRecord> {
  const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
    `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
    id,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
  }
  return toItemRecord(row);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const completeItem = defineOperation({
  name: "complete_item",
  kind: "write",
  summary:
    "Finishes an item: moves it into a completed state and records the closing summary that state requires.",
  contract,
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CompleteItemInput): Promise<CompleteItemResult> {
    const candidate = toCandidate(input.summary);

    // Run the same static validators the guard runs (`summaries/validate.ts`
    // — "reused by row #27's future transition-and-complete operation
    // directly, without going through the guard registry at all") *before*
    // touching the transition machinery, so a caller gets every shape/cap/
    // jargon/similarity problem in one rejection round rather than
    // discovering them one guard-rejection at a time. `summaryRequiredGuard`
    // still runs too, inside `applyTransition` below, and actually gates
    // the transition — this earlier check is a superset run for a better
    // error, not the enforcement mechanism itself.
    const shapeIssues = validateSummaryShape(candidate);
    const historyRows = await ctx.db.$queryRawUnsafe<{ body: string | null; payload: unknown }[]>(
      `SELECT "body", "payload" FROM "Event" WHERE "itemId" = $1`,
      input.id,
    );
    const similarityIssues = findSimilarityIssues(candidate, historyRows);
    const notDoneProofIssues = await checkNotDoneProofs(ctx, input.id, input.summary.not_done);

    const allIssues = [
      ...shapeIssues.map((i) => ({ field: i.field, message: i.message })),
      ...similarityIssues.map((i) => ({ field: i.field, message: i.message })),
      ...notDoneProofIssues,
    ];
    if (allIssues.length > 0) {
      throw new GuardRejectedError(
        "summaries.required_and_valid",
        allIssues.map((i) => i.message).join(" "),
        { fields: [...new Set(allIssues.map((i) => i.field))], details: { issues: allIssues } },
      );
    }

    // Merge the summary into the fields the transition's guards see —
    // `summaryRequiredGuard` reads `fields.summary` exactly as `transition`
    // does; `complete` differs only in also validating it up front and
    // owning the `Summary` row write below.
    const fields = { ...(input.fields ?? {}), summary: input.summary };
    const applied = await applyTransition(ctx, { itemId: input.id, to: input.to, fields });

    // The write path row #16 left for this row: `applyTransition` validates
    // `fields.summary` through the guard but does not persist it (this
    // module's own header). `Summary` is 1:1 with an item (SCHEMA.md §5),
    // so this upserts rather than assumes a fresh insert — an item that
    // reopens and completes a second time keeps exactly one summary row,
    // holding whatever it most recently completed with, which is the only
    // sensible reading of "1:1" for a row keyed on `item_id` alone with no
    // history of its own.
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "Summary" (
         "itemId", "shipped", "notDone", "userFacing", "whatToTest", "howVerified", "watchFor", "finalState"
       ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT ("itemId") DO UPDATE SET
         "shipped" = EXCLUDED."shipped",
         "notDone" = EXCLUDED."notDone",
         "userFacing" = EXCLUDED."userFacing",
         "whatToTest" = EXCLUDED."whatToTest",
         "howVerified" = EXCLUDED."howVerified",
         "watchFor" = EXCLUDED."watchFor",
         "finalState" = EXCLUDED."finalState",
         "createdAt" = now()`,
      input.id,
      JSON.stringify(input.summary.shipped),
      JSON.stringify(input.summary.not_done),
      input.summary.user_facing,
      input.summary.what_to_test === undefined ? null : JSON.stringify(input.summary.what_to_test),
      input.summary.how_verified ?? null,
      JSON.stringify(input.summary.watch_for),
      // `final_state` is "derived, never authored" (SCHEMA.md §5) — commit,
      // branch and merged_at are owned by rows this milestone has not yet
      // built (#29's checkpoint/note path, the merge guard's artifact).
      // Derived here, never taken from the caller, which is what makes it
      // trustworthy: `closed_on` is read back from the item's own artifacts,
      // never asserted by whoever is closing it.
      //
      // Why it belongs on the summary rather than only on the artifact: the
      // summary is the closing record a person reads, and an item closed on
      // an inspection rather than a review is exactly the fact that must not
      // require anyone to go digging through an artifact list to discover.
      // A distinction nobody can see is not a distinction.
      JSON.stringify(await deriveFinalState(ctx, input.id)),
    );

    // "Every mutating call appends a row" (SCHEMA.md §3) — same
    // `state-change` event `transition_item` writes for an ordinary move;
    // `complete` is a transition too, and the event ledger should not be
    // able to tell the two apart by omission.
    // Through `appendEvent` (#102), for the reason `transition_item` gives —
    // and with the same shape, which is the point of the comment above: the
    // ledger should not be able to tell a completion from an ordinary
    // transition by which columns happen to be populated.
    await appendEvent(ctx.db, {
      itemId: input.id,
      actor: callerEventActor(ctx.caller),
      assignmentId: await liveAssignmentId(ctx.db, input.id, ctx.caller),
      type: "state_change",
      payload: { from: applied.from, to: applied.to },
    });

    const item = await loadItemRecord(ctx, input.id);
    return { item };
  },
});
