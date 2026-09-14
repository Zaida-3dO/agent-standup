// Recovering token usage from the session transcript — MILESTONES.md #88,
// SCHEMA.md §10 (token counts) and §11 ("the hook reports model and effort
// on every call").
//
// ── Why this module has to exist ───────────────────────────────────────
//
// `./usage.ts` reads usage off the hook payload. It is correct, and for
// Claude Code it finds nothing, because **the payload does not carry usage
// under any key**. That was measured rather than assumed: a dump hook
// registered against a live session on 2026-09-14 captured these exact
// top-level key sets.
//
//   PostToolUse: session_id, transcript_path, cwd, prompt_id,
//                permission_mode, effort, hook_event_name, tool_name,
//                tool_input, tool_response, tool_use_id, duration_ms
//   Stop:        session_id, transcript_path, cwd, prompt_id,
//                permission_mode, effort, hook_event_name,
//                stop_hook_active, last_assistant_message,
//                background_tasks, session_crons
//   SessionEnd:  session_id, transcript_path, cwd, prompt_id,
//                hook_event_name, reason
//
// Not one field matching /usage|token|cost|model|price/ on any of them, and
// the vendor's own hooks reference agrees. So every spooled record read
// `inputTokens:0, outputTokens:0, cacheWriteTokens:0, cacheReadTokens:0` —
// not because the extraction was broken, but because its input genuinely
// does not exist.
//
// What every payload *does* carry is `transcript_path`, and that file does
// hold the counts. Its `type:"assistant"` lines carry `message.model` and a
// full `message.usage`:
//
//   {"input_tokens":3500,"cache_creation_input_tokens":24885,
//    "cache_read_input_tokens":0,"output_tokens":260, ...}
//
// So the usage is one hop away from something the hook is already handed.
// This module makes that hop.
//
// ── The three properties that govern every decision below ──────────────
//
// **1. It must never fail.** Same contract as `./usage.ts`, for the same
// reason and more sharply, because this one touches the filesystem. A
// missing file, an unreadable one, a partially-written line, a file owned
// by another user — every one of those must read as "nothing measured", not
// as an exception on the critical path of a tool call. Spooling is
// measurement; the hook's job is deciding whether a command may run.
//
// **2. The transcript lags, and that is documented.** The vendor states the
// transcript "is written asynchronously and may lag the in-memory
// conversation, so it may not yet include the current turn's most recent
// messages when a hook fires". A reading taken here is therefore a reading
// of what has been *flushed so far*, never a guarantee of the current turn.
// That is precisely why this reads CUMULATIVE totals and the caller takes a
// DELTA against what it has already attributed (see `usageDelta`): a lagging
// tail costs a later attribution, never a double-counted one. Summing
// per-call readings instead would count the same assistant turn once for
// every tool call in it, and inflate a bill several-fold.
//
// **3. The transcript's line schema is UNDOCUMENTED.** It was established
// by measurement rather than from a published contract, so it is a shape
// this reader hopes to find and must never require. Every field is
// therefore read defensively and an unrecognised line is skipped rather
// than treated as a parse failure. If the shape changes, this loses a
// measurement — recoverable — instead of denying tool calls.
//
// Nothing here caps or normalises the counts; `./spool-record.ts` owns that
// and already does it for every source.

/** Reads one property off an unknown value without asserting its whole shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A count as the transcript reports it, or zero.
 *
 * Deliberately the same shape of guard as `countOf` in `./spool-record.ts`
 * rather than a call to it: this runs before capping and its job is only to
 * keep a non-number out of an accumulator. A NaN admitted here would make
 * the whole cumulative sum NaN, which would then make every delta computed
 * from it NaN — one malformed line poisoning a whole session's metering.
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Cumulative usage across a transcript, plus the model that produced it.
 *
 * Counts are totals over every assistant message read, NOT one message's
 * reading — see property 2 above.
 */
export interface TranscriptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /**
   * The model on the most recent assistant message carrying one.
   *
   * Last rather than first, because a session that switches model mid-way
   * should report the model in force now. The run-boundary rule
   * (`@/lib/telemetry/run-boundary`) is what turns a change here into a run
   * cut; this only reports what it saw.
   */
  readonly model?: string;
}

const EMPTY: TranscriptUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/**
 * Totals the usage across one transcript's text.
 *
 * Pure — it takes the file's contents, never a path, so it is testable
 * without a filesystem and cannot be the thing that touches disk. The
 * reading of the file is the caller's job.
 *
 * A blank or unparseable line is skipped rather than aborting the scan. The
 * transcript is append-only and written asynchronously, so the LAST line is
 * routinely a partial write; treating that as a failure would discard an
 * entire session's usage for a byte that is about to arrive.
 */
export function readTranscriptUsage(contents: string): TranscriptUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let model: string | undefined;

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A partial trailing write, or a line this build does not understand.
      continue;
    }

    const message = property(parsed, "message");
    const usage = property(message, "usage");
    if (usage === undefined || usage === null) continue;

    inputTokens += count(property(usage, "input_tokens"));
    outputTokens += count(property(usage, "output_tokens"));
    cacheWriteTokens += count(property(usage, "cache_creation_input_tokens"));
    cacheReadTokens += count(property(usage, "cache_read_input_tokens"));

    const reported = property(message, "model");
    if (typeof reported === "string" && reported.trim().length > 0) {
      model = reported.trim();
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * The part of a cumulative reading that has not been attributed yet.
 *
 * This is what makes a lagging, re-read-from-the-top transcript safe to
 * meter from. `previous` is the cumulative total at the last call; the
 * difference is what belongs to this one.
 *
 * **Negatives clamp to zero, never carry through.** A cumulative total can
 * legitimately go backwards — a session is resumed against a fresh
 * transcript, a compaction rewrites history, a file is rotated. Subtracting
 * across that boundary yields a negative, and a negative token count
 * flowing into a cost is a credit against the bill: one rotated transcript
 * would silently cancel out real spend that had already been recorded.
 * Clamping loses the calls between the rotation and the next reading, which
 * is a visible under-count rather than an invisible wrong one.
 */
export function usageDelta(current: TranscriptUsage, previous: TranscriptUsage): TranscriptUsage {
  const positive = (now: number, before: number): number => (now > before ? now - before : 0);
  return {
    inputTokens: positive(current.inputTokens, previous.inputTokens),
    outputTokens: positive(current.outputTokens, previous.outputTokens),
    cacheWriteTokens: positive(current.cacheWriteTokens, previous.cacheWriteTokens),
    cacheReadTokens: positive(current.cacheReadTokens, previous.cacheReadTokens),
    ...(current.model === undefined ? {} : { model: current.model }),
  };
}

/** A reading of nothing — exported so callers need not construct the zero themselves. */
export function emptyTranscriptUsage(): TranscriptUsage {
  return EMPTY;
}
