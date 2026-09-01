// `orientation` — SCHEMA.md §19 `GET /items/{id}/orientation`, MILESTONES.md
// #28. "Catch me up": the latest checkpoint, the item's current state, what
// changed since that checkpoint, open loops, and who is on the crew.
//
// This is a **read**, and a bounded one. It reads `events` (row #20 —
// `readSinceBounded`/`visibilityHorizon`) and `assignments` (row #23 —
// `liveAssignments`) but writes nothing: the checkpoint and note *write*
// path is row #29's territory, not this one's (MILESTONES.md #28's own
// text: "#28 delivers orientation, which only *reads* checkpoints").
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ITEM_COLUMNS,
  NOT_ARCHIVED_CONDITION,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";
import { checkpointHeadline } from "../items/checkpoint-headline";
import { readSinceBounded, type EventRow } from "../../events";
import { liveAssignments, type Assignment, type Role } from "../../claims";
import { countsAsWork, deriveOpenLoops, type OpenLoop } from "../../open-loops";
import { previewText } from "./loop-reads";
import { loopEventsFor } from "./loop-shared";

/**
 * The `whatChanged` page bound — see `limit` in the input schema.
 *
 * **Deliberately small, because these are full events.** Each carries
 * `payload` and `body`, which measured ~7,400 characters apiece on a
 * realistic corpus — so 50 of them is ~370,000 characters and is refused
 * outright, and even 20 is ~148,000. The count that actually fits is
 * therefore in the low tens, which is the same arithmetic `get_events` ran
 * into from the other direction: on this table row *count* and response
 * *size* are barely related, so a bound that looks generous as a row count
 * is not one.
 *
 * 3 is a readable catch-up for a resuming session — the last few things
 * that happened, which is what "catch me up" actually asks for — and it is
 * what fits: at ~7,000 characters an event, five is already ~36,000 and ten
 * is ~70,000. 100 is the most a caller may ask for, and a caller asking for
 * it does so knowingly.
 *
 * The same number bounds the crew list below, which is a count of holders
 * rather than of events; it is generous for that and tight for these, which
 * is the right way round.
 */
const DEFAULT_CHANGED_EVENTS = 3;
const MAX_CHANGED_EVENTS = 100;

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    /**
     * Bound "what changed" to events with `id > since`. Omitted means
     * "since the latest checkpoint" (or the beginning of the ledger for
     * this item if there is no checkpoint yet) — the resume case a fresh
     * session actually has: it does not know a cursor of its own, only
     * that it wants everything since whatever was last recorded.
     */
    since: z.string().regex(/^\d+$/, "since must be a decimal integer string").optional(),
    /**
     * The most `whatChanged` events to return — MILESTONES.md #109.
     *
     * **This read carries the full event shape on purpose** (see the
     * `readSinceBounded` call below: `whatChanged` renders `payload` and
     * `body`), and until this bound existed it carried however many of them
     * the ledger held since the last checkpoint. On a busy item that is not
     * a small number: measured on this file's own corpus, an unbounded
     * `orientation` came to ~955,000 characters and was refused outright by
     * the response-size guard.
     *
     * `full: true` plus no bound is the combination that overflows, so the
     * read that legitimately needs the heavy columns is the one that most
     * needs a ceiling on how many of them it returns. Newest-first, because
     * a session catching up wants the most recent activity when it cannot
     * have all of it — see `whatChanged`'s own note.
     */
    limit: z.number().int().min(1).max(MAX_CHANGED_EVENTS).default(DEFAULT_CHANGED_EVENTS),
  })
  .strict();

export type OrientationInput = z.infer<typeof inputSchema>;

export interface OrientationCheckpoint {
  readonly eventId: string;
  readonly ts: string;
  readonly assignmentId: string | null;
  readonly body: string | null;
  /**
   * The checkpoint's one-line BLUF (MILESTONES.md #108) — what changed, in
   * one line, beside the prose in `body`.
   *
   * The stored value when the checkpoint carries one, otherwise a line
   * derived from the prose. Null only when there is neither: a checkpoint
   * with no headline and no readable prose, which nothing in the product
   * can write but which a corpus can hold. See `checkpointHeadline` for why
   * a fallback rather than null — a read that returns nothing for every
   * checkpoint written before the field existed is useless on precisely the
   * corpus that already exists.
   */
  readonly headline: string | null;
}

/** One entry from `Summary.notDone` (SCHEMA.md §5a), as stored — never re-validated here. */
export interface OpenLoopNotDone {
  readonly text: string;
  readonly reason: string;
  readonly itemId?: string;
}

/** A child of this item that still needs attention — actionable, or waiting (SCHEMA.md §5a, guard hierarchy.ts). */
export interface OpenLoopChild {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** `true` for the states `hierarchy.no_finish_with_actionable_child` treats as "more to do". */
  readonly actionable: boolean;
}

/**
 * One `events` row as `whatChanged` returns it — `EventRow` (events.ts) with
 * `id`/`txId` stringified. `bigint` cannot cross a JSON boundary at all
 * (`JSON.stringify`/`NextResponse.json` throw on one outright, rather than
 * silently truncating it), so every bigint column this operation returns is
 * stringified before it leaves the handler — the same choice `checkpoint`,
 * `changedSince` and `horizon` already make below.
 */
export interface OrientationChangedEvent {
  readonly id: string;
  readonly txId: string;
  readonly itemId: string | null;
  readonly ts: string;
  readonly actorType: EventRow["actorType"];
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly type: EventRow["type"];
  readonly payload: Record<string, unknown>;
  readonly body: string | null;
}

export interface OrientationOutput {
  readonly item: ItemRecord;
  /** Null if this item has never had a checkpoint recorded against it. */
  readonly checkpoint: OrientationCheckpoint | null;
  /**
   * Events with `id > since`, bounded to the visibility horizon
   * (`readSinceBounded` — SCHEMA.md §3), for this item. Empty when nothing
   * changed — the "nothing happened" case is a real, distinct answer from
   * "I don't know", not an error.
   */
  readonly whatChanged: readonly OrientationChangedEvent[];
  /**
   * True when this item had more events since `changedSince` than `limit`
   * returned, so `whatChanged` holds the most recent ones and not all of
   * them.
   *
   * Reported rather than left to be inferred from a full page, for the
   * reason the response-size guard states: a partial result a caller cannot
   * identify as partial is worse than none. A caller that needs the rest
   * raises `limit` or walks back with `since`.
   */
  readonly whatChangedTruncated: boolean;
  /**
   * True when this item has more live assignments than `limit` returned.
   *
   * Reported for the same reason as `whatChangedTruncated`: a partial list
   * a caller cannot identify as partial is worse than none. `get_fleet`
   * returns the whole crew, paged, for a caller that needs it.
   */
  readonly crewTruncated: boolean;
  /** The cursor `whatChanged` was read from — hand back as `since` on the next orientation call. */
  readonly changedSince: string;
  /** The horizon `whatChanged` was bounded to (SCHEMA.md §3) — how far "what changed" can be trusted. */
  readonly horizon: string;
  /**
   * Three genuinely different sources of "something is still outstanding on
   * this item", reported side by side rather than flattened into one list.
   *
   * They are not interchangeable and a caller usually wants a specific one:
   * `notDone` is what a **completed** item deliberately left undone
   * (`Summary`, written once at completion); `children` is unfinished work
   * that is itself an item; `loops` is a loose end the current session is
   * carrying that is not work anybody has filed. Merging them would need a
   * common shape none of them has, and would lose which kind of thing each
   * entry is — which is the first thing a resuming session needs to know,
   * because the three call for completely different responses.
   */
  readonly openLoops: {
    readonly notDone: readonly OpenLoopNotDone[];
    readonly children: readonly OpenLoopChild[];
    /**
     * Loops opened against this item and not yet closed — the only one of
     * the three an item can carry while it is still `executing`. See
     * `src/lib/open-loops.ts`.
     *
     * **Bounded in count and in text, like `whatChanged` and `crew`.** A
     * loop's text is prose and there is no ceiling on how many an item
     * accumulates: measured on a 40-loop item, this field alone took
     * `orientation` to 321,056 characters, over the response ceiling, so
     * the read failed outright and the loops could not be reached by any
     * setting of any parameter. Each entry now carries the first
     * ~200 characters, which is what "catch me up" needs; `loop_list` pages
     * them and `loop_get` returns one in full.
     */
    readonly loops: readonly OpenLoop[];
    /** True when this item has more open loops than were returned — read them all with `loop_list`. */
    readonly loopsTruncated: boolean;
    /** True when at least one returned loop's text was cut to its preview length. */
    readonly loopTextTruncated: boolean;
    /**
     * How many open loops were held back for being notes rather than work
     * (`kind: note`).
     *
     * Named rather than silently dropped: a reader has no way to tell "this
     * item has three loose ends" from "three loose ends and two notes you
     * are not being shown", and a count that shrank with no explanation is
     * the same failure as a truncation a caller cannot detect. Read them
     * with `loop_list { includeNonWork: true }`.
     */
    readonly nonWorkExcluded: number;
  };
  /** Live assignments on this item — who is on it and in what role (SCHEMA.md §2). */
  readonly crew: readonly Assignment[];
  /**
   * Live holders that have recorded nothing against this item since they
   * claimed it — a subset of `crew`, by assignment id.
   *
   * ── The failure this makes visible ──────────────────────────────────
   *
   * A crew that cannot reach the board still builds, still finishes, and
   * simply leaves no trace. The board then reads as though nothing
   * happened, which is indistinguishable from a crew that had nothing to
   * record — and is worse than an obvious error, because nobody goes
   * looking for notes that were never promised. Any interruption between
   * a claim and the work produces it: a restart, a network partition, an
   * endpoint that stops answering mid-run.
   *
   * The server can see this without being told. A claim is written by the
   * dispatcher, so it exists even when the holder never reaches the
   * service again — while every checkpoint, note and transition writes an
   * event carrying the writer's assignment or session. A live holder with
   * no event against this item has therefore left no trace on it.
   *
   * Note this is keyed on the **event ledger**, not on `lastActive`: that
   * column is stamped by `heartbeat` and the telemetry hook and by neither
   * `checkpoint` nor `note`, so a diligent unhooked crew would be reported
   * silent by a timestamp comparison while its checkpoints sat in plain
   * sight.
   *
   * **This is a report, not a judgement.** It does not evict, transition
   * or escalate anything — a session may legitimately be quiet for a
   * while, and a young claim is entirely ordinary. It turns a silent gap
   * into a visible one and leaves what to do about it to the reader,
   * which is the whole difference between a board that looks empty and a
   * board that says four crews were dispatched and none of them reported.
   *
   * Deliberately **not** filtered by an age threshold. A threshold here
   * would be a second, quieter policy competing with the liveness
   * settings that already own that question, and would hide exactly the
   * case worth seeing early. `quietForSeconds` is reported so a caller
   * can apply its own bar.
   */
  readonly silentCrew: readonly SilentCrewMember[];
}

/**
 * A live holder that has recorded nothing since it claimed.
 *
 * Carries only what identifies the holder and how long it has been quiet;
 * the full row is already in `crew` under the same `assignmentId`.
 */
export interface SilentCrewMember {
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly holderId: string;
  readonly role: Role;
  /** Seconds between the claim and the read — how long this holder has been silent. */
  readonly quietForSeconds: number;
}

interface RawCheckpointRow {
  id: bigint;
  ts: Date;
  assignmentId: string | null;
  body: string | null;
  headline: string | null;
}

interface RawSummaryRow {
  notDone: unknown;
}

interface RawChildRow {
  id: string;
  title: string;
  state: string;
}

/**
 * The states `hierarchy.no_finish_with_actionable_child` (guards/hierarchy.ts)
 * treats as "more to do" — re-declared here for the same reason that guard
 * re-declares it rather than importing `NON_ACTIONABLE_STATES`: this
 * question ("does orientation still owe attention to this child") is a
 * different cut of the vocabulary than the guard's own, and the two
 * happening to want the same set is a fact about the vocabulary, not a
 * coupling either module should carry.
 */
const NON_ACTIONABLE_STATES: ReadonlySet<string> = new Set([
  "blocked",
  "paused",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const orientation = defineOperation({
  name: "orientation",
  kind: "read",
  summary:
    "Catch me up: latest checkpoint, current state, what changed since, open loops, and crew.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: OrientationInput): Promise<OrientationOutput> {
    const itemRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    const itemRow = itemRows[0];
    if (!itemRow) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }
    const item = toItemRecord(itemRow);

    // The latest checkpoint (an `events` row of type `checkpoint` —
    // SCHEMA.md §4: "No checkpoints table... latest is `WHERE
    // type='checkpoint' AND assignment_id=A ORDER BY ts DESC LIMIT 1`").
    // Orientation is item-scoped rather than assignment-scoped, so this
    // reads the newest checkpoint against *this item* across every
    // assignment that has held it — the resume point any fresh session on
    // this item wants, not just one prior holder's.
    const checkpointRows = await ctx.db.$queryRawUnsafe<RawCheckpointRow[]>(
      `SELECT "id", "ts", "assignmentId", "body", "headline" FROM "Event"
       WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType"
       ORDER BY "id" DESC LIMIT 1`,
      input.itemId,
    );
    const checkpointRow = checkpointRows[0];
    const checkpoint: OrientationCheckpoint | null = checkpointRow
      ? {
          eventId: checkpointRow.id.toString(),
          ts: checkpointRow.ts.toISOString(),
          assignmentId: checkpointRow.assignmentId,
          body: checkpointRow.body,
          headline: checkpointHeadline(checkpointRow),
        }
      : null;

    // "What changed" defaults to since the latest checkpoint (or the
    // beginning, 0, if there has never been one) — a fresh session's actual
    // question is "what happened since the last thing I know about", and a
    // checkpoint is the one thing recorded specifically to answer it.
    const since = input.since !== undefined ? BigInt(input.since) : (checkpointRow?.id ?? 0n);
    // `full: true` because `whatChanged` renders `payload` and `body` —
    // this read is scoped to one item, so it carries the heavy columns for
    // a handful of rows rather than for the whole ledger. The projection is
    // named explicitly rather than relied on as a default: the default is
    // now the slim shape (MILESTONES.md #109), and a caller that needs the
    // heavy columns has to say so.
    const { events: allEvents, horizon } = await readSinceBounded(ctx.db, { since, full: true });
    // `readSinceBounded` reads the ledger table-wide (it has no `itemId`
    // filter of its own — SCHEMA.md §3's cross-item "since your last visit"
    // view and this item-scoped one are "the same rows, sliced
    // differently"). Slice to this item here, and stringify every bigint
    // column on the way out — `id`/`txId` cannot survive a JSON boundary as
    // `bigint` (`JSON.stringify` throws on one outright), which is exactly
    // what the HTTP route (`NextResponse.json`) would hit on the first
    // call if this operation returned `EventRow`s unmapped.
    const forThisItem = allEvents.filter((event) => event.itemId === input.itemId);
    // **Bounded to the most RECENT `limit` events, not the first.**
    // `readSinceBounded` returns ascending by `id`, so slicing from the
    // front would hand a catching-up session the oldest activity and drop
    // everything that happened since — the opposite of what "what changed"
    // is for. Taking from the end keeps the newest and preserves the
    // ascending order the field is documented to have.
    const truncated = forThisItem.length > input.limit;
    const whatChanged: OrientationChangedEvent[] = (
      truncated ? forThisItem.slice(-input.limit) : forThisItem
    ).map((event) => ({
      id: event.id.toString(),
      txId: event.txId.toString(),
      itemId: event.itemId,
      ts: event.ts.toISOString(),
      actorType: event.actorType,
      actorId: event.actorId,
      sessionId: event.sessionId,
      assignmentId: event.assignmentId,
      type: event.type,
      payload: event.payload,
      body: event.body,
    }));

    // Open loops, part one: this item's own recorded deferrals (SCHEMA.md
    // §5a `not_done`), if it has ever been completed with a Summary. Most
    // in-progress items have none yet — that's an empty list, not an error.
    const summaryRows = await ctx.db.$queryRawUnsafe<RawSummaryRow[]>(
      `SELECT "notDone" FROM "Summary" WHERE "itemId" = $1`,
      input.itemId,
    );
    const notDone = (summaryRows[0]?.notDone as OpenLoopNotDone[] | undefined) ?? [];

    // Open loops, part two: direct children that still need attention — the
    // same query and the same actionable/non-actionable split
    // `hierarchy.no_finish_with_actionable_child` enforces (guards/hierarchy.ts),
    // read here rather than imported because a guard module exports guard
    // objects, not a reusable query.
    const childRows = await ctx.db.$queryRawUnsafe<RawChildRow[]>(
      // Archived children are excluded for the same reason
      // `hierarchy.no_finish_with_actionable_child` excludes them: this is
      // the same question asked of the same relationship, one file over. An
      // archived row will never be transitioned again, because no ordinary
      // read can reach it to transition — so reporting it as an actionable
      // open loop points a session at work it cannot open, cannot move, and
      // cannot close.
      `SELECT "id", "title", "state" FROM "Item"
       WHERE "parentId" = $1 AND ${NOT_ARCHIVED_CONDITION}
       ORDER BY "createdAt" ASC`,
      input.itemId,
    );
    const children: OpenLoopChild[] = childRows.map((child) => ({
      id: child.id,
      title: child.title,
      state: child.state,
      actionable: !NON_ACTIONABLE_STATES.has(child.state),
    }));

    // Open loops, part three: loops opened against this item and never
    // closed (SCHEMA.md §3a).
    //
    // Read as its own query rather than sliced out of `whatChanged` above:
    // `whatChanged` is bounded twice — by the caller's cursor and by the
    // visibility horizon — and both bounds are wrong for this question. A
    // loop opened before the last checkpoint is still open now, and it is
    // precisely the oldest loops, the ones that have survived several
    // sessions, that a resuming session most needs to be told about. Scoping
    // them to "since you last looked" would hide exactly the ones that
    // matter.
    //
    // Read through `loopEventsFor` rather than with a fourth copy of the
    // same statement: the fold is only correct when handed the item's
    // *complete* loop-event slice in `id` order, so a copy that omitted an
    // event type would not fail loudly — it would report a closed or
    // deleted loop as open.
    // **Notes are excluded from the count, and the number held back is
    // reported.** This is the read a resuming session uses to judge how much
    // is still outstanding, so a list padded with references and status
    // markers misreports progress in the optimistic direction. Loops blocked
    // on a person are NOT held back — `countsAsWork` treats them as work,
    // because a loop waiting on a human is the most pending thing an item
    // can carry. Reported rather than silently dropped, for the reason the
    // truncation flags beside it are: a partial result a caller cannot
    // identify as partial is worse than none.
    const everyLoop = deriveOpenLoops(await loopEventsFor(ctx, input.itemId));
    const allLoops = everyLoop.filter((loop) => countsAsWork(loop.kind));
    const nonWorkExcluded = everyLoop.length - allLoops.length;
    // Bounded by the same `limit` that bounds `whatChanged` and `crew`, and
    // each text cut to a preview. Both bounds are reported rather than left
    // to be inferred, for the reason the other two are: a partial result a
    // caller cannot identify as partial is worse than none.
    const loopsTruncated = allLoops.length > input.limit;
    const boundedLoops = loopsTruncated ? allLoops.slice(0, input.limit) : allLoops;
    let loopTextTruncated = false;
    const loops: OpenLoop[] = boundedLoops.map((loop) => {
      const { preview, truncated } = previewText(loop.text);
      if (truncated) loopTextTruncated = true;
      return { ...loop, text: preview };
    });

    // **Bounded, like `whatChanged`.** `liveAssignments` is deliberately
    // unbounded — its other two callers are the claim guards, which have to
    // see *every* live row to decide whether a second crew has appeared, and
    // a limit there would be a correctness bug rather than a page size. So
    // the bound goes here, on the display copy, where the list is being
    // rendered rather than reasoned over. Measured on this file's corpus the
    // crew list was ~46,000 characters, larger than `whatChanged` itself.
    const allCrew = await liveAssignments(ctx.db, input.itemId);
    const crewTruncated = allCrew.length > input.limit;
    const crew = crewTruncated ? allCrew.slice(0, input.limit) : allCrew;

    // Which live holders have written anything to this item's ledger.
    //
    // **Keyed on recorded events, deliberately NOT on `lastActive`.** That
    // column looks like the obvious signal and is the wrong one here: it is
    // stamped by `heartbeat` and by the hook's telemetry flush, and by
    // neither `checkpoint` nor `note`. A holder running no hook that
    // checkpoints diligently therefore leaves `lastActive` frozen at its
    // claim, and keying on it would report the most conscientious
    // unhooked crew on the board as having recorded nothing. The question
    // being asked is "did this holder leave a trace", and the events are
    // the trace.
    //
    // Matched on `assignmentId` OR `sessionId`: an event is attributed to
    // the assignment when the writer resolved one, and some carry only the
    // session, so requiring the first would count a real trace as silence.
    //
    // **`claim` and `dispatch_claimed` are excluded, and that exclusion is
    // the crux.** Both are written *about* a holder at the moment it is
    // given the work, not *by* it — `claimItem` appends a `claim` event
    // carrying the new assignment and session in the same transaction that
    // inserts the row. Counting them would mean every holder appeared to
    // have left a trace the instant it was dispatched, and this field would
    // be empty forever: it would report exactly nothing while looking like
    // a working check, which is the same silent-green failure it exists to
    // expose. What is wanted is a record the holder itself went on to
    // write.
    const crewSessionIds = allCrew.map((member) => member.sessionId);
    const traceRows =
      allCrew.length === 0
        ? []
        : await ctx.db.$queryRawUnsafe<{ assignmentId: string | null; sessionId: string | null }[]>(
            `SELECT DISTINCT "assignmentId", "sessionId"
               FROM "Event"
              WHERE "itemId" = $1
                AND "type" NOT IN ('claim', 'dispatch_claimed')
                AND ("assignmentId" = ANY($2::text[]) OR "sessionId" = ANY($3::text[]))`,
            input.itemId,
            allCrew.map((member) => member.id),
            crewSessionIds,
          );
    const sawAssignment = new Set(
      traceRows.map((row) => row.assignmentId).filter((id): id is string => id !== null),
    );
    const sawSession = new Set(
      traceRows.map((row) => row.sessionId).filter((id): id is string => id !== null),
    );

    // Computed over `allCrew`, not the truncated display copy: a silent
    // holder that fell off the end of the page is exactly the one a reader
    // would otherwise never hear about.
    const readAt = Date.now();
    const silentCrew: SilentCrewMember[] = allCrew
      .filter((member) => !sawAssignment.has(member.id) && !sawSession.has(member.sessionId))
      .map((member) => ({
        assignmentId: member.id,
        sessionId: member.sessionId,
        holderId: member.holderId,
        role: member.role,
        quietForSeconds: Math.max(0, Math.round((readAt - member.claimedAt.getTime()) / 1000)),
      }));

    return {
      item,
      checkpoint,
      whatChanged,
      whatChangedTruncated: truncated,
      crewTruncated,
      changedSince: since.toString(),
      horizon: horizon.toString(),
      openLoops: { notDone, children, loops, loopsTruncated, loopTextTruncated, nonWorkExcluded },
      crew,
      silentCrew,
    };
  },
});
