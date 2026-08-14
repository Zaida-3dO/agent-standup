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
// ── Why the caps are here and not at the ingest ────────────────────────
//
// #50 caps the big fields server-side, and it must, because it cannot trust
// a client. That does not make capping here redundant: the spool is a file
// on a developer's machine that is appended to after *every* tool call, and
// the field most likely to be enormous is `command` — a heredoc writing a
// whole source file is a single Bash call whose command text is the file.
// Uncapped, one such call puts a megabyte on disk and, later, on the wire.
// So the cap is applied at the point the record is built, where the whole
// value is in hand and the truncation can be marked.
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

/**
 * How much of a command is kept.
 *
 * Chosen to comfortably hold any command a person would type or an agent
 * would compose, while refusing the pathological case (a file's whole
 * contents arriving as a heredoc). It is exported so the flush's batch
 * sizing can reason about a worst-case record rather than guessing.
 */
export const MAX_COMMAND_CHARS = 4000;

/** How many paths are kept from one call, and how long each may be. */
export const MAX_PATHS = 32;
export const MAX_PATH_CHARS = 512;

/** The marker appended to anything this module shortened. */
export const TRUNCATION_MARKER = "…[truncated]";

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
 */
export interface SpooledToolCall {
  readonly sessionId: string;
  readonly ts: string;
  readonly tool: string;
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /** The exact vendor model ID, when the tool reported one (§11 needs it to cut runs). */
  readonly model?: string;
  /** The literal effort value, when reported. */
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

/** Shortens `value` to `max` characters, marking it when it did. */
export function capText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + TRUNCATION_MARKER;
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
 * The paths one call touched, capped in both directions.
 *
 * Capped in count as well as in length because a single Glob or a
 * multi-file Edit can report hundreds, and `paths` exists to measure
 * *spread* (#54's "how wide the file spread is") — a signal that a cap of
 * 32 preserves the shape of and an uncapped list only makes more expensive.
 * Non-string entries are dropped rather than stringified: `[object Object]`
 * is not a path, and putting one on the spool would corrupt a
 * spread measurement with a value that can never match anything.
 */
export function capPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const entry of value) {
    if (kept.length >= MAX_PATHS) break;
    const one = label(entry, MAX_PATH_CHARS);
    if (one !== undefined) kept.push(one);
  }
  return kept.length === 0 ? undefined : kept;
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

  const tool = label(event.tool, 200);
  if (tool === undefined) return undefined;

  const command = event.command === undefined ? undefined : label(event.command, MAX_COMMAND_CHARS);
  const paths = capPaths(options.paths);
  const model = label(usage?.model, 200);
  const effort = label(usage?.effort, 200);
  const usage5h = readingOf(usage?.usage5h);
  const usageWeekly = readingOf(usage?.usageWeekly);

  return {
    sessionId: event.sessionId,
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
