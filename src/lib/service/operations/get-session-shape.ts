// `get_session_shape` — MILESTONES.md #54 ("Repeat-command detection, how
// wide the file spread is, read-to-write ratio"), reading the `tool_calls`
// rows #50 ingests (SCHEMA.md §10).
//
// The judgement itself lives in `@/lib/telemetry/shape`, which is pure. This
// operation is the part that cannot be: it decides *which rows* the reading
// is taken over, resolves the thresholds from settings, and hands both to
// that module. Keeping the split here means the interesting decisions — what
// counts as circling, what counts as wide — are testable without a database,
// and the database work is a query with no judgement in it.
//
// ── Why a window, and why it is calls rather than time ─────────────────
//
// A shape reading over a session's *entire* history answers a question
// nobody asked. A session that spent its morning circling and its afternoon
// working is, right now, working — and a consumer that acts on shape (#64's
// digest, #65's nudge) acts on how it is going *now*. So the reading is
// taken over the most recent calls.
//
// The window is a count of calls rather than a span of minutes because a
// session's pace is not constant: the same ten minutes holds four calls
// while a build runs and two hundred while an agent reads a directory tree.
// A time window therefore reads a different amount of evidence every time it
// is asked, and the two signals most sensitive to sample size — the repeat
// count and the read share — would move with the pace of the session rather
// than with its shape. A fixed call count reads the same amount of evidence
// every time, which is what makes two readings comparable at all.
//
// ── The window is bounded here rather than by the caller ───────────────
//
// `tool_calls` is "the highest-volume table" (§10) and this operation is
// reachable over MCP, HTTP and the command line, so an unbounded `limit`
// from a caller is a full-table scan waiting to be typed. The bound is a
// constant rather than a setting: unlike the thresholds, which describe the
// repository being worked in, this one describes what the *server* is
// willing to read into memory to answer one question, which is not a
// judgement an installation is better placed to make.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  readSessionShape,
  type SessionShape,
  type ShapeCall,
  type ShapeThresholds,
} from "@/lib/telemetry/shape";

/**
 * The most calls one reading is taken over, and the default.
 *
 * 200 is set against the two signals that need the most evidence. A read
 * share over fewer than a few dozen calls swings on a single tool call, and
 * a repeat count needs enough room for a session to leave a command and
 * come back to it — the very thing it measures. It is also comfortably
 * inside one index range scan on `ToolCall_sessionId_ts_idx`, so the query
 * stays a bounded read of a hot index rather than a scan whose cost grows
 * with how long a session has been running.
 */
export const MAX_SHAPE_WINDOW = 500;
export const DEFAULT_SHAPE_WINDOW = 200;

const inputSchema = z
  .object({
    /**
     * Whose calls to read. Required, and there is deliberately no
     * "everything" mode: shape is a property of one session's work, and a
     * reading pooled across sessions would blend two agents' commands into
     * a repeat count neither of them earned.
     */
    sessionId: z.string().min(1),
    /** How many of the most recent calls to read. */
    limit: z.number().int().positive().max(MAX_SHAPE_WINDOW).optional(),
  })
  .strict();

export type GetSessionShapeInput = z.infer<typeof inputSchema>;

export interface GetSessionShapeOutput extends SessionShape {
  readonly sessionId: string;
  /**
   * The thresholds this reading was taken against.
   *
   * Returned rather than left implicit because a level is meaningless
   * without them: a consumer shown `elevated` and the number 7 cannot tell
   * whether the threshold was 5 or 50, and the same reading means different
   * things on two installations that configured `shape.*` differently. It
   * also makes a surprising verdict diagnosable from its own output rather
   * than by going and reading the settings table.
   */
  readonly thresholds: ShapeThresholds;
}

/** The projection a shape reading needs — see `ShapeCall`. */
interface ShapeRow {
  readonly tool: string;
  readonly command: string | null;
  readonly paths: string[] | null;
  readonly ts: Date;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getSessionShape = defineOperation({
  name: "get_session_shape",
  kind: "read",
  summary:
    "Reads the shape of a session's recent work: whether it is repeating commands, how wide its file spread is, and how much of it is reading rather than changing.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetSessionShapeInput): Promise<GetSessionShapeOutput> {
    const limit = input.limit ?? DEFAULT_SHAPE_WINDOW;

    // Newest first in the query so the index gives the window directly, then
    // reversed below into the order the signals read. Doing it the other way
    // — oldest-first with an offset — would mean counting past every row the
    // window excludes, which is the scan this bound exists to avoid.
    const rows = await ctx.db.$queryRawUnsafe<ShapeRow[]>(
      `SELECT "tool", "command", "paths", "ts"
         FROM "ToolCall"
        WHERE "sessionId" = $1
        ORDER BY "ts" DESC, "id" DESC
        LIMIT $2`,
      input.sessionId,
      limit,
    );

    // Back into chronological order. Repeat detection reads "did this session
    // leave a command and come back to it", which is a question about
    // sequence — read backwards, a return looks identical to a departure and
    // the count is silently taken over a session that never happened.
    const calls: ShapeCall[] = rows
      .slice()
      .reverse()
      .map((row) => ({
        tool: row.tool,
        command: row.command,
        paths: row.paths,
        ts: row.ts,
      }));

    const thresholds = shapeThresholds(ctx);

    return {
      sessionId: input.sessionId,
      thresholds,
      ...readSessionShape(calls, thresholds),
    };
  },
});

/**
 * The `shape.*` settings, as the pure module wants them.
 *
 * A function rather than an inline object literal so that the mapping from
 * setting key to threshold field exists in exactly one place — the two
 * vocabularies are deliberately different (a settings key is snake_cased and
 * namespaced, a threshold field is not) and a second copy of the mapping is
 * a second place for them to drift apart.
 */
function shapeThresholds(ctx: ServiceContext): ShapeThresholds {
  return {
    minimumSample: ctx.settings.values["shape.minimum_sample"],
    repeatThreshold: ctx.settings.values["shape.repeat_threshold"],
    spreadThreshold: ctx.settings.values["shape.spread_threshold"],
    readShareThreshold: ctx.settings.values["shape.read_share_threshold"],
  };
}
