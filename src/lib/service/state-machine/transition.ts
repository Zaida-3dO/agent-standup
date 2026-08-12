// The state machine's core: evaluate or apply one transition.
// See docs/plans/MILESTONES.md #15, SCHEMA.md §16, DECISIONS.md §13c.
//
// This is a library, not a registered operation — row #27 ("Transition and
// complete — the service calls and their routes, with rehearsal mode") is
// what exposes this to adapters. What lives here is the mechanism every
// caller of that future operation shares: fetching the item, refusing to run
// guards against a project, running whichever guards `appliesTo` the pair,
// and either reporting the outcome (rehearsal) or writing it (real).
import { ForbiddenError, NotFoundError } from "../errors";
import { guardRegistry, runGuards, type GuardableItem, type GuardRegistry } from "./guard";
import { isItemState, type ItemStateValue } from "./states";
import type { ServiceContext } from "../context";

export interface TransitionRequest {
  readonly itemId: string;
  readonly to: string;
  /**
   * Extra fields the caller supplies alongside the move — `blocked_reason`
   * when entering `blocked`, and so on. Guards read these; the base
   * mechanism here does not interpret them, because which fields matter for
   * which state is exactly what rows #16-#19 register guards to check, not
   * something this module hard-codes.
   */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * What `rehearseTransition` reports.
 *
 * `applyTransition` does not return this shape: a real transition either
 * succeeds (see `AppliedTransition` below) or throws — see that function's
 * own doc for why a returned rejection would be the wrong contract for it.
 * Rehearsal is different on purpose: `dry_run=true` **evaluates and reports**
 * rather than raising (SCHEMA.md §16), because the caller is asking "what
 * would happen", not asking to be told the answer only when it's yes.
 */
export interface TransitionOutcome {
  readonly itemId: string;
  readonly from: ItemStateValue;
  readonly to: ItemStateValue;
  /** Whether the move would be allowed. */
  readonly allowed: boolean;
  /** Present iff `allowed` is false. */
  readonly rejection?: {
    readonly code: "guard_rejected";
    readonly guard: string;
    readonly message: string;
    readonly fields: readonly string[];
  };
  /** Always `true` here — `rehearseTransition` never writes. */
  readonly rehearsed: true;
}

/** What `applyTransition` returns — only ever a successful move, since a rejection throws instead. */
export interface AppliedTransition {
  readonly itemId: string;
  readonly from: ItemStateValue;
  readonly to: ItemStateValue;
}

const ITEM_COLUMNS = `
  "id", "kind", "state", "blockedReason", "blockedOnType", "blockedOnPersonId",
  "unblockAt", "pauseReason", "resumeCondition", "needsVisualReview", "mergeAuthority"
`;

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  blockedReason: string | null;
  blockedOnType: string | null;
  blockedOnPersonId: string | null;
  unblockAt: Date | null;
  pauseReason: string | null;
  resumeCondition: string | null;
  needsVisualReview: boolean;
  mergeAuthority: string;
}

function toGuardableItem(row: ItemRow): GuardableItem {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    blockedReason: row.blockedReason,
    blockedOnType: row.blockedOnType,
    blockedOnPersonId: row.blockedOnPersonId,
    unblockAt: row.unblockAt,
    pauseReason: row.pauseReason,
    resumeCondition: row.resumeCondition,
    needsVisualReview: row.needsVisualReview,
    mergeAuthority: row.mergeAuthority,
  };
}

/**
 * Loads the item a transition targets, inside the call's one transaction.
 *
 * Exported so `operations/*` in later rows (#27) can reuse the same fetch
 * rather than writing a second raw query that could drift from this one's
 * column list.
 */
export async function loadItemForTransition(
  ctx: ServiceContext,
  itemId: string,
): Promise<GuardableItem> {
  const rows = await ctx.db.$queryRawUnsafe<ItemRow[]>(
    `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
    itemId,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No such item: ${itemId}.`, { fields: ["itemId"] });
  }
  return toGuardableItem(row);
}

export class ProjectHasNoStateError extends ForbiddenError {
  constructor(itemId: string) {
    super(
      `${itemId} is a project. A project's state is derived from its children — see ` +
        "DECISIONS.md §13c — so it has no state to transition and no guard runs against it.",
      { fields: ["itemId"] },
    );
  }
}

/**
 * The shared core of rehearsal and real transitions.
 *
 * Both paths run through here so they can never diverge on *what counts as
 * allowed* — the only difference between them is the one `write` step at the
 * very end, which rehearsal skips outright.
 *
 * Every `(from, to)` pair reaches guard evaluation; there is no whitelist
 * check that could refuse a pair before a guard even runs (SCHEMA.md §16,
 * "Every state can reach every other state. There is no edge whitelist.").
 * A project is the one exception, and it is refused *before* guard
 * evaluation for a reason worth stating: a project's `kind` is `project`
 * because it has no parent, and that fact alone is enough to know no guard
 * should be asked anything about it — running guards against it and having
 * them all happen to pass would still be the wrong shape, because it would
 * imply a project's state is a thing that can be true or false, which
 * DECISIONS.md §13c says it never is.
 */
async function evaluate(
  ctx: ServiceContext,
  request: TransitionRequest,
  registry: GuardRegistry,
): Promise<{
  item: GuardableItem;
  from: ItemStateValue;
  to: ItemStateValue;
  rejection?: Awaited<ReturnType<typeof runGuards>>;
}> {
  if (!isItemState(request.to)) {
    throw new NotFoundError(`Not a valid state: ${request.to}.`, { fields: ["to"] });
  }

  const item = await loadItemForTransition(ctx, request.itemId);

  if (item.kind === "project") {
    throw new ProjectHasNoStateError(request.itemId);
  }

  if (!isItemState(item.state)) {
    // Reachable only if a row's stored state has drifted out of the
    // vocabulary this module knows — a data problem, not a caller error.
    throw new NotFoundError(`Item ${request.itemId} has an unrecognised state: ${item.state}.`, {
      fields: ["itemId"],
    });
  }

  const from = item.state;
  const to = request.to;

  const applicable = registry.applicable(from, to);
  const rejection = await runGuards(applicable, {
    item,
    from,
    to,
    fields: request.fields ?? {},
    db: ctx.db,
    settings: ctx.settings,
  });

  return { item, from, to, rejection };
}

/**
 * Rehearses `request`: reports what would happen without writing anything.
 *
 * "Reports a preview object" proves nothing on its own — what makes this
 * rehearsal rather than narration is that the write step below never runs
 * on this path, which `tests/state-machine-transition.test.ts` checks by
 * querying the database afterwards, not by trusting the return value.
 */
export async function rehearseTransition(
  ctx: ServiceContext,
  request: TransitionRequest,
  registry: GuardRegistry = guardRegistry,
): Promise<TransitionOutcome> {
  const { from, to, rejection } = await evaluate(ctx, request, registry);
  return buildOutcome(request.itemId, from, to, rejection);
}

/**
 * Applies `request`: on an allowed transition, writes the new state (and
 * clears the `blocked`/`paused` fields SCHEMA.md §16 requires cleared on any
 * transition leaving those two states) inside the caller's transaction.
 *
 * **On a rejection, this throws the `GuardRejectedError` rather than
 * returning it.** That is not a stylistic choice: row #14's runtime commits
 * whenever an operation's handler *resolves*, and only rolls back when it
 * *throws* (`runtime.ts` — "The body throws to abandon it; there is no
 * partial-commit path"). A guard can write through `ctx.db` before it
 * refuses — the same `ctx.db` the rest of the operation uses, per this
 * module's whole point of being a citizen of that boundary rather than a
 * parallel one — and if a rejection here were merely *returned*, the
 * operation handler that called `applyTransition` and passed the result
 * straight back would resolve normally, the runtime would commit, and that
 * guard's write would survive a transition the caller was just told did not
 * happen. Throwing is what makes "the guard rejected it" and "nothing this
 * evaluation wrote survives" the same event instead of two events a caller
 * could observe out of step with each other.
 *
 * Row #14's transaction boundary is what this relies on rather than
 * reimplements: `ctx.db` already is the one transaction the runtime opened
 * for this call, so "committed or rolled back together with everything else
 * this operation does" falls out of using it rather than opening a second
 * one.
 */
export async function applyTransition(
  ctx: ServiceContext,
  request: TransitionRequest,
  registry: GuardRegistry = guardRegistry,
): Promise<AppliedTransition> {
  const { from, to, rejection } = await evaluate(ctx, request, registry);
  if (rejection) {
    throw rejection;
  }

  // Clearing `blocked`/`paused` fields is keyed off **`to`, not `from`**
  // (SCHEMA.md §16 "anything, from blocked/paused → those fields cleared in
  // the same transaction" reads as leaving the state, which a `to` that is
  // still `blocked`/`paused` has not done). Keying off `from` alone would
  // clear the very fields row #16's guards just required: `blocked →
  // blocked` with a fresh `blocked_reason` would validate, write the new
  // reason below, and then this same statement would immediately null it
  // back out, because `from === "blocked"` is true regardless of where the
  // move landed. `blocked → blocked` must end with the *new* reason stored,
  // so clearing only fires on a genuine exit.
  const clearingBlocked = from === "blocked" && to !== "blocked";
  const clearingPaused = from === "paused" && to !== "paused";
  const completedStates = new Set(["merged", "research_done", "wont_do", "cancelled"]);

  // Fields supplied alongside entry to `blocked`/`paused` are what row #16's
  // guards just validated are present — they still have to land in the
  // columns those guards are guarding, or `blocked_reason` (etc.) never
  // actually changes even on an accepted transition. The write only fires
  // when `enteringBlocked`/`enteringPaused` is true (`$6`/`$11` in the SQL
  // below); every other transition falls through to `ELSE "<column>"`, which
  // leaves the existing value exactly as it was — so a transition that isn't
  // entering the state can never stomp it with `NULL` through this path.
  // Clearing that value on a genuine exit is the
  // `clearingBlocked`/`clearingPaused` branch's job, evaluated first in each
  // `CASE`, not this one's.
  const enteringBlocked = to === "blocked";
  const enteringPaused = to === "paused";
  const blockedReason = enteringBlocked ? toNullableString(request.fields?.blocked_reason) : null;
  const blockedOnType = enteringBlocked ? toNullableString(request.fields?.blocked_on_type) : null;
  const blockedOnPersonId = enteringBlocked
    ? toNullableString(request.fields?.blocked_on_person)
    : null;
  const unblockAt = enteringBlocked ? toNullableDate(request.fields?.unblock_at) : null;
  const pauseReason = enteringPaused ? toNullableString(request.fields?.pause_reason) : null;
  const resumeCondition = enteringPaused
    ? toNullableString(request.fields?.resume_condition)
    : null;

  await ctx.db.$executeRawUnsafe(
    // `$1::"ItemState"` and `$3::"BlockedOnType"` — Postgres cannot infer
    // that a text-typed bind parameter should coerce to the enum column it
    // is being assigned to (unlike a literal, which it does infer), and
    // refuses the statement outright rather than guessing. The other bind
    // parameters need no such cast: the `CASE WHEN <bool>` ones infer
    // `boolean` from context the same way a literal `true`/`false` would,
    // and the plain value columns keep the type Prisma already declared.
    `UPDATE "Item" SET
       "state" = $1::"ItemState",
       "blockedReason" = CASE WHEN $2 THEN NULL WHEN $6 THEN $7 ELSE "blockedReason" END,
       "blockedOnType" = CASE WHEN $2 THEN NULL WHEN $6 THEN $8::"BlockedOnType" ELSE "blockedOnType" END,
       "blockedOnPersonId" = CASE WHEN $2 THEN NULL WHEN $6 THEN $9 ELSE "blockedOnPersonId" END,
       "unblockAt" = CASE WHEN $2 THEN NULL WHEN $6 THEN $10::timestamptz ELSE "unblockAt" END,
       "pauseReason" = CASE WHEN $3 THEN NULL WHEN $11 THEN $12 ELSE "pauseReason" END,
       "resumeCondition" = CASE WHEN $3 THEN NULL WHEN $11 THEN $13 ELSE "resumeCondition" END,
       "completedAt" = CASE WHEN $4 THEN now() ELSE "completedAt" END,
       "updatedAt" = now()
     WHERE "id" = $5`,
    to,
    clearingBlocked,
    clearingPaused,
    completedStates.has(to),
    request.itemId,
    enteringBlocked,
    blockedReason,
    blockedOnType,
    blockedOnPersonId,
    unblockAt,
    enteringPaused,
    pauseReason,
    resumeCondition,
  );

  return { itemId: request.itemId, from, to };
}

/** Coerces a guard-checked `fields` value to a string for a raw `UPDATE`, or `null`. */
function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Coerces a guard-checked `fields` value to an ISO string for the
 * `timestamptz` bind above, or `null`. Accepts the same two shapes the
 * `unblock_at` guard in `guards/blocked-paused.ts` accepts — a `Date` (an
 * in-process call) or an ISO string (an adapter that has already
 * deserialised JSON) — so this and that guard never disagree about what
 * counts as a valid value.
 */
function toNullableDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : value;
  }
  return null;
}

function buildOutcome(
  itemId: string,
  from: ItemStateValue,
  to: ItemStateValue,
  rejection: Awaited<ReturnType<typeof runGuards>>,
): TransitionOutcome {
  if (!rejection) {
    return { itemId, from, to, allowed: true, rehearsed: true };
  }
  return {
    itemId,
    from,
    to,
    allowed: false,
    rehearsed: true,
    rejection: {
      code: "guard_rejected",
      guard: rejection.guard,
      message: rejection.message,
      fields: rejection.fields,
    },
  };
}
