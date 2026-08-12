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

/** The four states a `complete` call may land on (SCHEMA.md §1.1's "Completed" column). */
const COMPLETED_STATES = ["merged", "research_done", "wont_do", "cancelled"] as const;

const notDoneEntrySchema = z
  .object({
    text: z.string(),
    reason: z.enum(["follow-up", "needs-approval", "descoped"]),
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
 * Checks SCHEMA.md §5a's per-entry proof for a `not_done` reason of
 * `follow-up` or `needs-approval`: the linked `item_id` must exist, and must
 * be in the state that reason claims (not actionable, for `follow-up`;
 * `blocked` with `blocked_on_type = person`, for `needs-approval`).
 * `descoped` needs no linked item at all.
 *
 * This is the one piece of §5a's static-validator surface that
 * `validateSummaryShape` (pure, no database) cannot check on its own — it
 * needs to read the linked item's current row, so it lives here rather than
 * in `summaries/validate.ts`, the same split `findSimilarityIssues` already
 * draws for the one other database-dependent check.
 */
async function checkNotDoneProofs(
  ctx: ServiceContext,
  notDone: CompleteItemInput["summary"]["not_done"],
): Promise<{ field: string; message: string }[]> {
  const issues: { field: string; message: string }[] = [];
  const NON_ACTIONABLE = new Set([
    "blocked",
    "paused",
    "merged",
    "research_done",
    "wont_do",
    "cancelled",
  ]);

  for (let i = 0; i < notDone.length; i++) {
    const entry = notDone[i]!;
    if (entry.reason === "descoped") continue;

    if (!entry.item_id) {
      issues.push({
        field: `not_done[${i}].item_id`,
        message: `not_done[${i}] has reason "${entry.reason}", which requires a minted item_id.`,
      });
      continue;
    }

    const rows = await ctx.db.$queryRawUnsafe<{ state: string; blockedOnType: string | null }[]>(
      `SELECT "state", "blockedOnType" FROM "Item" WHERE "id" = $1`,
      entry.item_id,
    );
    const linked = rows[0];
    if (!linked) {
      issues.push({
        field: `not_done[${i}].item_id`,
        message: `not_done[${i}].item_id (${entry.item_id}) does not name an existing item.`,
      });
      continue;
    }

    if (entry.reason === "follow-up") {
      // Required: the linked item is actionable (SCHEMA.md §5a — a
      // `follow-up` proves it's actually blocked by pointing at an item
      // that is *not* actionable). An actionable linked item means nothing
      // is stopping the work from happening now, which is exactly the case
      // this reason must not be usable for.
      if (NON_ACTIONABLE.has(linked.state)) continue;
      issues.push({
        field: `not_done[${i}].item_id`,
        message:
          "You're deferring this, but nothing is blocking it. Is there a good reason you didn't " +
          "just do it now? If not, go back to executing and finish it.",
      });
    } else if (entry.reason === "needs-approval") {
      if (linked.state !== "blocked" || linked.blockedOnType !== "person") {
        issues.push({
          field: `not_done[${i}].item_id`,
          message: `not_done[${i}].item_id (${entry.item_id}) must be blocked with blocked_on_type "person" for reason "needs-approval".`,
        });
      }
    }
  }

  return issues;
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

export const completeItem = defineOperation({
  name: "complete_item",
  kind: "write",
  summary:
    "Finishes an item: moves it into a completed state and records the closing summary that state requires.",
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
    const notDoneProofIssues = await checkNotDoneProofs(ctx, input.summary.not_done);

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
      // An empty object is the honest value this row can compute; a future
      // row that adds those fields extends this write, it does not replace
      // this one's shape.
      JSON.stringify({}),
    );

    // "Every mutating call appends a row" (SCHEMA.md §3) — same
    // `state-change` event `transition_item` writes for an ordinary move;
    // `complete` is a transition too, and the event ledger should not be
    // able to tell the two apart by omission.
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload")
       VALUES ($1, $2::"ActorType", $3, 'state_change'::"EventType", $4::jsonb)`,
      input.id,
      ctx.caller.actor ? "agent" : "system",
      ctx.caller.actor ?? null,
      JSON.stringify({ from: applied.from, to: applied.to }),
    );

    const item = await loadItemRecord(ctx, input.id);
    return { item };
  },
});
