// The telemetry record the hook spools — MILESTONES.md #88 ("the hook
// payload on stdin, the local telemetry spool and its batched flush"),
// SCHEMA.md §10 (`tool_calls`).
//
// This module turns one parsed `HookEvent` plus whatever usage the agent
// tool reported into the value that goes on the spool. It is the local half
// of what #50 ingests server-side, and it deliberately produces a shape that
// mirrors `tool_calls` field for field rather than a hook-shaped blob the
// server would have to re-interpret: the row that reads these is written by
// someone else, and a payload whose field names have to be translated is a
// payload whose translation can be wrong in one direction only — silently.
//
// ── Why the caps are here and not only at the ingest ───────────────────
//
// The ingest caps the big fields server-side, and it must, because it
// cannot trust a client. That does not make capping here redundant: the
// spool is a file on a developer's machine that is appended to after
// *every* tool call, and the field most likely to be enormous is `command`
// — a heredoc writing a whole source file is a single Bash call whose
// command text is the file. Uncapped, one such call puts a megabyte on disk
// and, later, on the wire. So the cap is applied at the point the record is
// built, where the whole value is in hand and the truncation can be marked.
//
// **The limits and the capping functions are imported from
// `@/lib/telemetry/contract`, never redefined here.** That module is the one
// place they are stated, and it is shared with the ingest deliberately: two
// independent sets of numbers is the shape where a client trims to one
// bound and the server re-trims to a tighter one, leaving the marker
// stranded in the *middle* of the stored value. That produces a wrong
// measurement rather than a partial one, which is exactly what the caps
// exist to prevent — and it is invisible from either side alone, because
// each is individually behaving correctly.
//
// **Truncation is recorded, never silent.** A truncated string keeps a
// visible marker, so a person reading a spooled record can tell the
// difference between "the agent ran a short command" and "the agent ran
// something this build declined to keep". A cap that leaves no trace turns
// a measurement into a quiet lie, and the measurements are the entire point
// of the milestone this row belongs to.
//
// Nothing here touches the filesystem, the clock or the process. The
// timestamp is a parameter, as it is everywhere else in `src/lib/hook/**`.

import type { HookEvent } from "./payload";
import {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  TRUNCATION_MARKER,
  capPaths as capPathList,
  capText,
} from "@/lib/telemetry/contract";

export {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  TRUNCATION_MARKER,
  capText,
};

/**
 * One spooled tool call, shaped to `tool_calls` (SCHEMA.md §10).
 *
 * Field names are the API's camelCase rather than the table's snake_case:
 * the spool is read by the flush and posted to an endpoint, not to Postgres,
 * and every other transport surface in this application is camelCase.
 *
 * The four token counts are separate and never folded into a total, for the
 * reason §10 states outright: they price at wildly different rates, so one
 * total destroys the information the table exists to hold.
 *
 * ── This is the SPOOL's shape, not the wire's ──────────────────────────
 *
 * Three fields here are deliberately not part of what gets sent, and the
 * distinction is the reason this type and the request body are not the same
 * type. `./flush.ts` is where the two are reconciled; see `toWireCall`
 * there for which fields are dropped and why. Keeping the spool wider than
 * the wire is the point rather than an oversight: the spool is the capture,
 * and a field that is captured can be forwarded later, while a field that
 * was never captured is gone for good.
 */
export interface SpooledToolCall {
  /**
   * Whose call this is.
   *
   * Held on **every record** even though the ingest carries it once per
   * request, on the envelope. The spool is an append-only file that a
   * single machine writes from every session on it, so a record that did
   * not name its own session could only be attributed by its position in
   * the file — which stops being true the moment two sessions interleave,
   * which is the normal case. The flush groups by this field and lifts it
   * onto the envelope.
   */
  readonly sessionId: string;
  readonly ts: string;
  readonly tool: string;
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /**
   * The exact vendor model ID, when the tool reported one.
   *
   * **Captured but not yet sent** — there is no column for it and no
   * receiver until row **#51** (runs), which is what will consume it: §11
   * requires the hook to report model and effort on every call, because
   * without them a mid-session `/model` switch is invisible and a run
   * silently spans two models, attributing its score to a blend.
   *
   * It is spooled now regardless, because #51 cannot be backfilled from
   * data nobody captured — the same argument M7 makes for the whole
   * milestone. The cost of capturing early is a few bytes per record; the
   * cost of capturing late is every run before the switch being ungradeable.
   */
  readonly model?: string;
  /** The literal effort value, when reported. Captured but not yet sent — see `model`. */
  readonly effort?: string;
  readonly usage5h?: number;
  readonly usageWeekly?: number;
}

/**
 * The usage an agent tool reported alongside the event.
 *
 * Every field is optional because no agent tool is obliged to report any of
 * them, and a build that required them would spool nothing at all against a
 * tool that reports none — losing the tool name, the command and the
 * timing, which are useful on their own. Absent counts read as zero;
 * absent model, effort and budget snapshots are simply absent, because zero
 * is a meaningful reading for a budget and "not reported" is not.
 */
export interface ReportedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheReadTokens?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly usage5h?: number;
  readonly usageWeekly?: number;
}

/**
 * A count as it is stored: a non-negative integer, or zero.
 *
 * Anything else — a negative, a fraction, a NaN, an Infinity, a value that
 * was never a number — becomes zero rather than being carried through. A
 * token count is summed downstream into costs, and one NaN in a sum makes
 * the whole sum NaN: a single malformed report from one tool version would
 * otherwise destroy the arithmetic for every call it is aggregated with.
 */
export function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * A budget reading as it is stored, or `undefined`.
 *
 * Unlike a token count this is **not** floored to zero when absent, because
 * a budget snapshot of zero means "nothing used" and is a real reading the
 * planner would act on. Conflating "not reported" with "zero used" would
 * make an unreported budget look like a completely fresh window, which is
 * the most misleading value available. Fractions are kept — a percentage of
 * a window is not an integer.
 */
export function readingOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Trimmed, non-empty, capped. `undefined` when there is nothing to keep. */
function label(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return capText(trimmed, max);
}

/**
 * The paths one call touched, cleaned and then capped.
 *
 * The capping itself is `@/lib/telemetry/contract`'s `capPaths`, so the client
 * and the ingest bound this field by the same numbers in the same order.
 * What is done *here* and not there is the cleaning: non-string entries are
 * dropped rather than stringified, and blank entries are dropped rather
 * than kept. `[object Object]` is not a path, and putting one on the spool
 * would corrupt a spread measurement with a value that can never match
 * anything.
 *
 * The two steps are in this order because dropping junk after the count cap
 * would let a list of 64 nulls consume the whole allowance and arrive
 * empty, which reads as "this call touched nothing" — a wrong measurement
 * rather than a partial one. Cleaning first means the cap is spent on real
 * paths.
 */
export function capPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) cleaned.push(trimmed);
  }
  if (cleaned.length === 0) return undefined;
  return capPathList(cleaned);
}

export interface BuildRecordOptions {
  readonly event: HookEvent;
  /** Epoch milliseconds. Injected, as everywhere else in this directory. */
  readonly now: number;
  readonly usage?: ReportedUsage;
  /** Paths the call touched, when the payload carried them. */
  readonly paths?: unknown;
}

/**
 * Builds the record for one event, or `undefined` when there is nothing
 * worth spooling.
 *
 * **A `Stop` spools nothing.** It names no tool, so it would produce a row
 * whose `tool` column had to be invented, and §10's table is one row per
 * tool call. The session-level facts a `Stop` does carry belong to #47's
 * stop-hook catch, not to this table.
 *
 * Note that this returns `undefined` rather than throwing for the case it
 * declines: the caller is a hook on the critical path of every tool call,
 * and a telemetry record that could throw would be a telemetry record that
 * could take a tool call down with it. Nothing about spooling is allowed to
 * affect whether a command runs.
 */
export function buildRecord(options: BuildRecordOptions): SpooledToolCall | undefined {
  const { event, now, usage } = options;

  const tool = label(event.tool, MAX_TOOL_CHARS);
  if (tool === undefined) return undefined;

  const command = event.command === undefined ? undefined : label(event.command, MAX_COMMAND_CHARS);
  const paths = capPaths(options.paths);
  // `model` and `effort` are identifiers, so they share the tool name's
  // bound rather than having one invented for them — a vendor model ID is
  // the same shape and order of length as an MCP-namespaced tool name.
  const model = label(usage?.model, MAX_TOOL_CHARS);
  const effort = label(usage?.effort, MAX_TOOL_CHARS);
  const usage5h = readingOf(usage?.usage5h);
  const usageWeekly = readingOf(usage?.usageWeekly);

  return {
    // Capped to the same bound the ingest applies, so the value the flush
    // groups by is the value the server stores. Capping only server-side
    // would let two sessions whose ids differ past the cap be spooled apart
    // and stored together, which merges two sessions' telemetry silently.
    sessionId: capText(event.sessionId, MAX_SESSION_ID_CHARS),
    ts: new Date(now).toISOString(),
    tool,
    ...(command === undefined ? {} : { command }),
    ...(paths === undefined ? {} : { paths }),
    inputTokens: countOf(usage?.inputTokens),
    outputTokens: countOf(usage?.outputTokens),
    cacheWriteTokens: countOf(usage?.cacheWriteTokens),
    cacheReadTokens: countOf(usage?.cacheReadTokens),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(usage5h === undefined ? {} : { usage5h }),
    ...(usageWeekly === undefined ? {} : { usageWeekly }),
  };
}
