// Maintaining `runs` as telemetry arrives — MILESTONES.md #51 (runs) and
// #52 (cost), SCHEMA.md §11.
//
// The *rule* for where a run ends lives in `@/lib/telemetry/run-boundary`
// as a pure function, and the *arithmetic* for what a run cost lives in
// `@/lib/telemetry/pricing` as another. This module is the part that cannot
// be pure: it reads the open run, opens and closes rows, and accumulates
// counts. Keeping the two decisions out of it is what makes them testable
// without a database, and what stops the interesting logic from being
// reachable only through an ingest that also writes a hundred other rows.
//
// ── Accumulation is incremental; costing is not ────────────────────────
//
// The four token counts are added to the stored ones on every batch, which
// is the only option: a batch arrives with no knowledge of the batches
// before it, and re-deriving a run's counts would mean scanning its calls
// on every flush — the scan §11 exists as a rollup to avoid.
//
// **The cost is recomputed from the accumulated counts, never incremented
// alongside them.** That is #52's "always recomputable" taken literally,
// and the difference shows up the first time a price changes: an
// incremented cost is a running total of figures computed under whatever
// rates happened to be configured at each flush, so it corresponds to no
// price table that ever existed and cannot be reproduced from anything.
// Recomputed, the stored figure is always exactly what the current table
// yields for the counts stored beside it — which is checkable by anyone,
// with one multiplication, and correctable by editing a rate and running
// the same computation again.
//
// The cost of recomputing is four multiplications on a row already being
// written. There is no case for the cheaper wrong number.
import type { TransactionHandle } from "../context";
import type { SettingsSnapshot } from "@/lib/settings";
import { costForModel, type ModelPrices } from "@/lib/telemetry/pricing";
import { decideRun, type ReportedFacets } from "@/lib/telemetry/run-boundary";

/** A run as this module tracks it between calls in one batch. */
export interface RunState {
  readonly id: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly toolCallCount: number;
  /** Calls attributed to it from the batch in progress, for the operation's report. */
  readonly callsThisBatch: number;
  /** True when the batch in progress opened it. */
  readonly opened: boolean;
}

/** Where a run is attached. Every field is required — a run always has an item. */
export interface RunOwner {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly sessionId: string;
  /** The item's state at ingest, carried onto the run for the per-stage rollup (#53). */
  readonly stateAt: string | null;
}

interface OpenRunRow {
  readonly id: string;
  readonly model: string;
  readonly effort: string;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly toolCallCount: number;
}

/**
 * The model recorded for a run that has been told nothing.
 *
 * `Run.model` and `Run.effort` are NOT NULL — §11 requires both to score
 * and to price a run — but a run can be opened by a call that reported
 * neither, which is routine rather than exceptional. So an explicit
 * placeholder is stored, and it is a *sentinel a reader can recognise*
 * rather than an empty string.
 *
 * The distinction matters more than it looks. An empty string is what a
 * malformed report also produces, so a column full of them cannot be told
 * apart from a client bug; and it sorts and groups alongside real values in
 * any rollup that does not know to exclude it. A named sentinel is visible
 * in a query result, cannot collide with a vendor ID, and reads as what it
 * is when it turns up on a dashboard.
 *
 * It is never priced: `pricing.model_prices` is keyed by exact vendor ID,
 * so a run still carrying the sentinel has no rate and costs `null` — which
 * is the honest answer for work nobody could attribute to a model.
 */
export const UNREPORTED = "(unreported)";

/**
 * The open run for an assignment, or null when there is none.
 *
 * One row by construction: a run is closed the moment its successor is
 * opened, in the same transaction, so two open runs on one assignment is a
 * state this module never creates. `LIMIT 1` with a newest-first order is a
 * belt-and-braces read rather than a claim that duplicates are impossible —
 * if one ever existed, attributing to the newest is the same rule the
 * assignment lookup uses and is the least surprising recovery.
 */
export async function openRun(
  db: TransactionHandle,
  assignmentId: string,
): Promise<RunState | null> {
  const rows = await db.$queryRawUnsafe<OpenRunRow[]>(
    `SELECT "id", "model", "effort", "inputTokens", "outputTokens",
            "cacheWriteTokens", "cacheReadTokens", "toolCallCount"
     FROM "Run"
     WHERE "assignmentId" = $1 AND "endedAt" IS NULL
     ORDER BY "startedAt" DESC
     LIMIT 1`,
    assignmentId,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    // The sentinel is unwrapped back to null on the way in, so the boundary
    // rule sees "nothing was ever reported" rather than a model name that
    // every real report would differ from — which would cut a new run on
    // the first genuine report instead of adopting it into this one.
    model: row.model === UNREPORTED ? null : row.model,
    effort: row.effort === UNREPORTED ? null : row.effort,
    inputTokens: BigInt(row.inputTokens),
    outputTokens: BigInt(row.outputTokens),
    cacheWriteTokens: BigInt(row.cacheWriteTokens),
    cacheReadTokens: BigInt(row.cacheReadTokens),
    toolCallCount: row.toolCallCount,
    callsThisBatch: 0,
    opened: false,
  };
}

/** The four counts one call contributes. Absent counts are zero, per §10. */
export interface CallCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * Attributes one call to a run, opening or cutting one where the boundary
 * rule says to, and returns the run the call was attributed to.
 *
 * **The run row is not written here.** Every call in a batch would otherwise
 * cost an `UPDATE` — up to 500 per flush, all but the last immediately
 * superseded. The state is accumulated in memory across the batch and
 * flushed once by `persistRun`, which is the same number of round trips a
 * per-call write would make on the *last* call and none of the ones before
 * it. What must happen per call is the boundary decision, because a
 * decision deferred to the end of a batch could not tell which calls
 * belonged to which side of a mid-batch model change.
 *
 * A `cut` closes the previous run first, so the invariant "at most one open
 * run per assignment" holds between calls and not merely at the end of a
 * batch. If it held only at the end, a batch that failed midway would leave
 * two open runs behind and the next flush would attribute to whichever the
 * ordering happened to surface.
 */
export async function attribute(
  db: TransactionHandle,
  owner: RunOwner,
  current: RunState | null,
  reported: ReportedFacets,
  counts: CallCounts,
  at: Date,
  prices: ModelPrices,
): Promise<RunState> {
  const decision = decideRun(
    current === null ? null : { model: current.model, effort: current.effort },
    reported,
  );

  if (decision.action === "cut") {
    if (current !== null) {
      await persistRun(db, current, prices);
      await closeRun(db, current.id, at);
    }
    const opened = await insertRun(db, owner, decision.model, decision.effort, at);
    return addCall(opened, counts);
  }

  // `current` is non-null for `keep` and `adopt`: `decideRun` returns `cut`
  // for a null open run, so reaching here with none would mean the rule
  // changed underneath this call site.
  if (current === null) {
    throw new Error("attribute: non-cut decision with no open run");
  }

  const withFacets =
    decision.action === "adopt"
      ? { ...current, model: decision.model, effort: decision.effort }
      : current;

  return addCall(withFacets, counts);
}

/**
 * Writes a run's accumulated counts, its facets and its recomputed cost.
 *
 * Called once per run per batch — at the end for the run still open, and at
 * the moment of a cut for the one being closed.
 *
 * The cost is computed here rather than passed in so that there is exactly
 * one site where a stored cost comes into being. A second site would be a
 * second chance for the stored figure to stop matching the counts beside
 * it, which is the property #52 exists to hold.
 */
export async function persistRun(
  db: TransactionHandle,
  run: RunState,
  prices: ModelPrices,
): Promise<number | null> {
  const model = run.model ?? UNREPORTED;
  const { cost } = costForModel(
    model,
    {
      inputTokens: Number(run.inputTokens),
      outputTokens: Number(run.outputTokens),
      cacheWriteTokens: Number(run.cacheWriteTokens),
      cacheReadTokens: Number(run.cacheReadTokens),
    },
    prices,
  );

  await db.$executeRawUnsafe(
    `UPDATE "Run"
     SET "model" = $2, "effort" = $3,
         "inputTokens" = $4, "outputTokens" = $5,
         "cacheWriteTokens" = $6, "cacheReadTokens" = $7,
         "toolCallCount" = $8, "cost" = $9
     WHERE "id" = $1`,
    run.id,
    model,
    run.effort ?? UNREPORTED,
    run.inputTokens,
    run.outputTokens,
    run.cacheWriteTokens,
    run.cacheReadTokens,
    run.toolCallCount,
    cost,
  );
  return cost;
}

/** Marks a run ended. Separate from `persistRun` so a close always follows a write of the final counts. */
async function closeRun(db: TransactionHandle, id: string, at: Date): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE "Run" SET "endedAt" = $2 WHERE "id" = $1`, id, at);
}

/**
 * Opens a run.
 *
 * `selectionReason` is left null deliberately, and the migration relaxed the
 * column to permit it: every value of that enum states why a *dispatch*
 * chose a model, and nothing in a telemetry report carries that. Recording
 * `recommended` here would put runs nobody recommended anything about into
 * the comparison group the model picker grades recommendations against.
 */
async function insertRun(
  db: TransactionHandle,
  owner: RunOwner,
  model: string | null,
  effort: string | null,
  at: Date,
): Promise<RunState> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Run"
       ("id", "itemId", "assignmentId", "sessionId", "stateAt", "startedAt", "model", "effort")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"ItemState", $5, $6, $7)
     RETURNING "id"`,
    owner.itemId,
    owner.assignmentId,
    owner.sessionId,
    owner.stateAt,
    at,
    model ?? UNREPORTED,
    effort ?? UNREPORTED,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("insertRun: no id returned");
  return {
    id,
    model,
    effort,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheWriteTokens: 0n,
    cacheReadTokens: 0n,
    toolCallCount: 0,
    callsThisBatch: 0,
    opened: true,
  };
}

/**
 * Adds one call's counts to a run's running totals.
 *
 * `BigInt` rather than `number` because the column is `BIGINT` and a run is
 * unbounded in length: a long-lived run accumulating `INTEGER`-bounded
 * per-call counts will eventually exceed what a double can represent
 * exactly, and the failure mode of exceeding it is not an error — it is
 * silently wrong arithmetic in the direction of *smaller*, on the largest
 * runs, which are the ones a cost report is about.
 */
function addCall(run: RunState, counts: CallCounts): RunState {
  return {
    ...run,
    inputTokens: run.inputTokens + BigInt(counts.inputTokens),
    outputTokens: run.outputTokens + BigInt(counts.outputTokens),
    cacheWriteTokens: run.cacheWriteTokens + BigInt(counts.cacheWriteTokens),
    cacheReadTokens: run.cacheReadTokens + BigInt(counts.cacheReadTokens),
    toolCallCount: run.toolCallCount + 1,
    callsThisBatch: run.callsThisBatch + 1,
  };
}

/** The configured price table, read from the one setting that holds it. */
export function pricesFrom(settings: SettingsSnapshot): ModelPrices {
  return settings.values["pricing.model_prices"];
}
