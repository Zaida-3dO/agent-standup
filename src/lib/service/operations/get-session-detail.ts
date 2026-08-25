// `get_session_detail` — what one agent actually did, end to end. T19:
// "One session: its assignments, tool calls, cost, timeline."
//
// The natural drill-down from `/fleet`'s table, and the diagnostic for the
// question a fleet row raises but cannot answer: this session has been
// running for three hours — doing what?
//
// ── What this is not, and why it is not those ───────────────────────────
//
// Two operations already read a session's rows, and neither answers this.
//
// `get_session_shape` (#54) reads the same `tool_calls` and returns a
// *judgement* over a rolling window — is this session circling, how wide is
// its file spread, what is its read-to-write ratio. That is a reading of how
// a session is behaving right now. It deliberately looks at the most recent
// calls only, and it returns no assignments, no cost and no history, because
// none of those inform the judgement.
//
// `get_costs` with `groupBy: "session"` returns one row of totals. That is
// the money question, and it is the one this operation reuses rather than
// recomputing — see below.
//
// This is the third question: the record. Who this session was working for,
// what it did, what that cost, and what it wrote to the ledger.
//
// ── The cost figure is `get_costs`' own, not a second computation ───────
//
// The task brief is explicit that a second aggregation must not appear, and
// the reason is stronger here than mere duplication: `get_costs` recomputes
// cost from token counts at current rates rather than summing stored figures
// (its header explains why at length). A per-session total computed any other
// way would disagree with the same session's row on the cost screen, and two
// authoritative-looking figures that differ is worse than one of them being
// absent.
//
// So the totals here come from calling that operation's own `fold` over the
// same per-(group, model) sums, against the same price table from settings.
// The SQL differs only in its `WHERE` — one session rather than all of them.
//
// ── Every section is bounded, and the timeline is the reason ────────────
//
// A session's tool calls are the highest-volume rows in the schema (§10) and
// a long session's ledger is thousands of events. Both are capped here and
// both report their true total alongside, so a truncated view is never
// mistaken for a complete one. The ledger is *not* paged from this
// operation: `get_activity` already pages the ledger and takes a `sessionId`
// filter, so this returns the newest slice for the first paint and a caller
// wanting more walks it there. Building a second cursor over the same table
// is exactly what the task brief rules out.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { pricesFrom } from "../telemetry/runs";
import { fold, type CostGroup } from "./get-costs";

/**
 * The caps on the two unbounded sections.
 *
 * Small because this is a first paint, and both sections have a paged read
 * behind them for anyone who wants more: `get_activity` for the ledger,
 * `get_session_shape` for a wider window of calls.
 */
const DEFAULT_RECENT_CALLS = 50;
const MAX_RECENT_CALLS = 200;
const DEFAULT_RECENT_EVENTS = 50;
const MAX_RECENT_EVENTS = 200;

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
    /** How many of the most recent tool calls to return. */
    callLimit: z.number().int().min(1).max(MAX_RECENT_CALLS).optional(),
    /** How many of the most recent ledger entries to return. */
    eventLimit: z.number().int().min(1).max(MAX_RECENT_EVENTS).optional(),
    /**
     * Include each tool call's `command` and `paths`.
     *
     * Off by default for the reason the ledger reads give: a command line is
     * unbounded text and a path list is an unbounded array, so a page of 50
     * carrying both is a response whose size is unrelated to its row count.
     * The tool name and timestamp alone answer "what was it doing"; the
     * command answers "exactly what did it run", which is a second question.
     */
    full: z.boolean().default(false),
  })
  .strict();

export type GetSessionDetailInput = z.infer<typeof inputSchema>;

/** The registration facts — what this session is and where it runs. */
export interface SessionDetailSession {
  readonly id: string;
  readonly machine: string;
  readonly transport: string;
  readonly client: string | null;
  readonly personId: string | null;
  readonly driveMode: string | null;
  readonly hookVariant: string | null;
  readonly hookVersion: number | null;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

/** One thing this session was working on. */
export interface SessionDetailAssignment {
  readonly id: string;
  readonly itemId: string;
  /** Resolved so a row reads as prose rather than as an id. */
  readonly itemTitle: string | null;
  readonly role: string;
  readonly holderType: string;
  readonly holderId: string;
  readonly liveness: string;
  readonly branch: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly claimedAt: string;
  readonly lastActive: string;
  readonly releasedAt: string | null;
}

/** One tool call, slim unless `full` was asked for. */
export interface SessionDetailToolCall {
  readonly id: string;
  readonly ts: string;
  readonly tool: string;
  readonly itemId: string | null;
  readonly stateAt: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/** `SessionDetailToolCall` plus the two unbounded fields. */
export interface SessionDetailToolCallFull extends SessionDetailToolCall {
  readonly command: string | null;
  readonly paths: readonly string[];
}

/** One ledger entry this session wrote. */
export interface SessionDetailEvent {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly headline: string | null;
}

export interface GetSessionDetailOutput {
  readonly session: SessionDetailSession;
  readonly assignments: readonly SessionDetailAssignment[];
  /**
   * This session's totals — `get_costs`' own arithmetic over this session's
   * runs. Null when the session has no runs at all, which is distinct from
   * a zero total: a session that made no priced calls and a session that
   * cost nothing are different facts.
   */
  readonly cost: CostGroup | null;
  /** Models with no configured rate among this session's runs, so a short total is explicable. */
  readonly unpricedModels: readonly string[];
  readonly recentCalls: readonly (SessionDetailToolCall | SessionDetailToolCallFull)[];
  /** How many tool calls this session has made in total — so a capped list is visibly capped. */
  readonly totalCalls: number;
  /** The newest ledger entries. Page further with `get_activity`'s `sessionId` filter. */
  readonly recentEvents: readonly SessionDetailEvent[];
  /** How many ledger entries this session has written in total. */
  readonly totalEvents: number;
}

interface RawSessionRow {
  id: string;
  machine: string;
  transport: string;
  client: string | null;
  personId: string | null;
  driveMode: string | null;
  hookVariant: string | null;
  hookVersion: number | null;
  registeredAt: Date;
  lastSeenAt: Date;
}

interface RawAssignmentRow {
  id: string;
  itemId: string;
  itemTitle: string | null;
  role: string;
  holderType: string;
  holderId: string;
  liveness: string;
  branch: string | null;
  model: string | null;
  effort: string | null;
  claimedAt: Date;
  lastActive: Date;
  releasedAt: Date | null;
}

interface RawCallRow {
  id: bigint;
  ts: Date;
  tool: string;
  itemId: string | null;
  stateAt: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  command?: string | null;
  paths?: string[];
}

interface RawEventRow {
  id: bigint;
  ts: Date;
  type: string;
  itemId: string | null;
  itemTitle: string | null;
  headline: string | null;
}

interface RawRunCostRow {
  key: string | null;
  model: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheWriteTokens: bigint;
  cacheReadTokens: bigint;
  toolCallCount: number;
  runs: number;
}

/**
 * The slim tool-call columns — everything but `command` and `paths`.
 *
 * Exported so a test can assert what is asked of Postgres, for the reason
 * `SLIM_ACTIVITY_COLUMNS` gives: selecting the unbounded columns and then
 * dropping them in the mapping returns the right shape while paying the
 * full transfer cost, which no assertion on the response can detect.
 */
export const SLIM_CALL_COLUMNS = `"id", "ts", "tool", "itemId", "stateAt"::text AS "stateAt",
              "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"`;

/** The slim columns plus the two unbounded ones. */
export const FULL_CALL_COLUMNS = `${SLIM_CALL_COLUMNS}, "command", "paths"`;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getSessionDetail = defineOperation({
  name: "get_session_detail",
  kind: "read",
  summary:
    "One session end to end: its registration, assignments, recent tool calls, recomputed cost and recent ledger entries. Omits each call's command and paths; pass full for those.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: GetSessionDetailInput,
  ): Promise<GetSessionDetailOutput> {
    const callLimit = input.callLimit ?? DEFAULT_RECENT_CALLS;
    const eventLimit = input.eventLimit ?? DEFAULT_RECENT_EVENTS;

    const sessionRows = await ctx.db.$queryRawUnsafe<RawSessionRow[]>(
      `SELECT "id", "machine", "transport"::text AS "transport", "client", "personId",
              "driveMode"::text AS "driveMode", "hookVariant"::text AS "hookVariant",
              "hookVersion", "registeredAt", "lastSeenAt"
       FROM "Session" WHERE "id" = $1`,
      input.sessionId,
    );
    const session = sessionRows[0];
    // Refused explicitly rather than returned as an empty shell. Every other
    // read here is over rows keyed by `sessionId`, where an unknown session
    // simply has none — so without this, a typo'd id would return a
    // plausible-looking record of a session that did nothing, which reads
    // exactly like a real session that has not started yet.
    if (!session) {
      throw new NotFoundError(`No such session: ${input.sessionId}.`, { fields: ["sessionId"] });
    }

    const assignmentRows = await ctx.db.$queryRawUnsafe<RawAssignmentRow[]>(
      `SELECT a."id", a."itemId", i."title" AS "itemTitle", a."role"::text AS "role",
              a."holderType"::text AS "holderType", a."holderId",
              a."liveness"::text AS "liveness", a."branch", a."model", a."effort",
              a."claimedAt", a."lastActive", a."releasedAt"
       FROM "Assignment" a
       LEFT JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1
       ORDER BY a."claimedAt" DESC, a."id" DESC`,
      input.sessionId,
    );

    // The cost, from `get_costs`' own fold over this session's runs. The
    // grouping key is the session, so a well-formed result holds at most one
    // group — see the module header on why this is not a second computation.
    const costRows = await ctx.db.$queryRawUnsafe<RawRunCostRow[]>(
      `SELECT "sessionId" AS "key",
              "model",
              SUM("inputTokens")::bigint      AS "inputTokens",
              SUM("outputTokens")::bigint     AS "outputTokens",
              SUM("cacheWriteTokens")::bigint AS "cacheWriteTokens",
              SUM("cacheReadTokens")::bigint  AS "cacheReadTokens",
              SUM("toolCallCount")::int       AS "toolCallCount",
              COUNT(*)::int                   AS "runs"
       FROM "Run" WHERE "sessionId" = $1
       GROUP BY 1, "model"`,
      input.sessionId,
    );
    const folded = fold(costRows, "session", pricesFrom(ctx.settings), 1);

    const countRows = await ctx.db.$queryRawUnsafe<{ calls: bigint; events: bigint }[]>(
      `SELECT (SELECT COUNT(*) FROM "ToolCall" WHERE "sessionId" = $1)::bigint AS "calls",
              (SELECT COUNT(*) FROM "Event"    WHERE "sessionId" = $1)::bigint AS "events"`,
      input.sessionId,
    );
    const totalCalls = Number(countRows[0]?.calls ?? 0);
    const totalEvents = Number(countRows[0]?.events ?? 0);

    const callRows = await ctx.db.$queryRawUnsafe<RawCallRow[]>(
      `SELECT ${input.full ? FULL_CALL_COLUMNS : SLIM_CALL_COLUMNS}
       FROM "ToolCall" WHERE "sessionId" = $1
       ORDER BY "ts" DESC, "id" DESC LIMIT $2`,
      input.sessionId,
      callLimit,
    );

    const eventRows = await ctx.db.$queryRawUnsafe<RawEventRow[]>(
      `SELECT e."id", e."ts", e."type"::text AS "type", e."itemId",
              i."title" AS "itemTitle", e."headline"
       FROM "Event" e
       LEFT JOIN "Item" i ON i."id" = e."itemId"
       WHERE e."sessionId" = $1
       ORDER BY e."id" DESC LIMIT $2`,
      input.sessionId,
      eventLimit,
    );

    return {
      session: {
        id: session.id,
        machine: session.machine,
        transport: session.transport,
        client: session.client,
        personId: session.personId,
        driveMode: session.driveMode,
        hookVariant: session.hookVariant,
        hookVersion: session.hookVersion,
        registeredAt: session.registeredAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
      },
      assignments: assignmentRows.map((row) => ({
        id: row.id,
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        role: row.role,
        holderType: row.holderType,
        holderId: row.holderId,
        liveness: row.liveness,
        branch: row.branch,
        model: row.model,
        effort: row.effort,
        claimedAt: row.claimedAt.toISOString(),
        lastActive: row.lastActive.toISOString(),
        releasedAt: row.releasedAt?.toISOString() ?? null,
      })),
      // `?? null` rather than an empty group: a session with no runs has no
      // cost *record*, which the header distinguishes from a zero total.
      cost: folded.groups[0] ?? null,
      unpricedModels: folded.unpricedModels,
      recentCalls: callRows.map((row) => {
        const slim: SessionDetailToolCall = {
          id: row.id.toString(),
          ts: row.ts.toISOString(),
          tool: row.tool,
          itemId: row.itemId,
          stateAt: row.stateAt,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          cacheReadTokens: row.cacheReadTokens,
        };
        if (!input.full) return slim;
        return { ...slim, command: row.command ?? null, paths: row.paths ?? [] };
      }),
      totalCalls,
      recentEvents: eventRows.map((row) => ({
        id: row.id.toString(),
        ts: row.ts.toISOString(),
        type: row.type,
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        headline: row.headline,
      })),
      totalEvents,
    };
  },
});
