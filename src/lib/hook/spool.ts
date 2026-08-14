// The local telemetry spool — MILESTONES.md #88, DECISIONS.md §13f:
// "telemetry spools locally and flushes in batches rather than opening a
// connection per call."
//
// That sentence is the requirement, and the reason behind it is a hard
// constraint on everything in this file: **the hook runs on the critical
// path of every tool call.** Whatever spooling costs, an agent pays it
// hundreds of times an hour. So the write path is one append of one line to
// one file — no read of what is already there, no parse, no rewrite, no
// lock. Everything expensive happens at flush time, which is off the
// critical path by construction.
//
// ── Why JSON Lines, specifically ───────────────────────────────────────
//
// A JSON *array* would have to be read, parsed, appended to and rewritten
// on every tool call — the exact cost the batching exists to avoid — and a
// process killed mid-rewrite leaves a file that parses as nothing, losing
// every record rather than the one being written. With one JSON object per
// line, an append is an append, and a torn write damages exactly the line
// it tore: `readSpool` skips it and keeps the rest.
//
// That last property is the one worth stating plainly, because it is the
// difference between a spool and a log: **a malformed line is skipped, never
// fatal.** Telemetry that refuses to load because one line is corrupt is
// telemetry that gets deleted by whoever hits it, and then there is none.
//
// ── The ceiling, and which end it drops from ───────────────────────────
//
// A spool that only grows is a disk that eventually fills, and a machine
// whose server has been unreachable for a week is exactly when nobody is
// watching. So there is a ceiling — and when it is reached, **the oldest
// records are dropped, never the newest.** Two reasons: the newest records
// describe what is happening now, which is what anyone reading this would
// be looking at; and dropping the newest means a full spool silently stops
// recording, which looks identical to a spool that is working.
//
// A drop is counted and reported rather than being silent, for the same
// reason truncation is marked in `./spool-record.ts`: a measurement that
// quietly lost data is worse than one that says how much it lost.
//
// Nothing in this file touches the filesystem. It is string in, string out —
// which is what lets a full spool, a torn line and a file of pure garbage be
// tested as values.

import type { SpooledToolCall } from "./spool-record";

/**
 * How many records the spool holds before the oldest are dropped.
 *
 * Sized against what a machine accumulates while its server is unreachable:
 * a busy agent makes a few thousand tool calls a day, so this is roughly a
 * few days of total outage, held in a file of a few megabytes. Large enough
 * that the drop path is not reached in ordinary operation; small enough that
 * a forgotten machine never becomes a disk-space incident.
 */
export const DEFAULT_MAX_RECORDS = 20_000;

/**
 * How many records go in one flush request.
 *
 * Comfortably under the ingest's own per-request ceiling, which refuses an
 * over-sized batch rather than truncating it — the right call server-side,
 * since a truncated batch would discard whole calls and leave the client
 * unable to tell how many landed. The consequence for this side is that the
 * client's batch size is not merely a tuning knob: a value above the
 * server's limit turns every flush into a permanent rejection, and the
 * spool then grows to its ceiling and starts dropping. Staying well below
 * it leaves room for that limit to be lowered without this becoming a
 * lock-out.
 */
export const DEFAULT_BATCH_SIZE = 200;

/** One line's worth of spooled record, plus what reading it cost. */
export interface SpoolContents {
  readonly records: readonly SpooledToolCall[];
  /**
   * Lines that were present but could not be read as a record. Reported
   * rather than thrown, and counted rather than merely noted, because "one
   * torn line after a crash" and "every line is garbage" need different
   * responses and are indistinguishable from a boolean.
   */
  readonly skipped: number;
}

/** Serialises one record as the line to append. Always ends with a newline. */
export function serialiseRecord(record: SpooledToolCall): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * A record, or `undefined` if this text is not one.
 *
 * The check is deliberately shallow: an object with a `sessionId`, a `ts`
 * and a `tool` is enough to be worth keeping and forwarding. A strict
 * schema here would reject records written by a *newer* build of the hook
 * that added a field — on the same machine, into the same file, which is a
 * completely ordinary thing to happen across an upgrade — and rejecting
 * them would silently discard real telemetry to enforce a shape the server
 * validates anyway.
 */
export function parseRecord(line: string): SpooledToolCall | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const value = raw as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
  if (typeof value.ts !== "string" || value.ts.length === 0) return undefined;
  if (typeof value.tool !== "string" || value.tool.length === 0) return undefined;

  return raw as SpooledToolCall;
}

/**
 * Reads the whole spool.
 *
 * Blank lines are not counted as skipped — a trailing newline is the normal
 * state of an append-only file, not damage, and counting it would report a
 * corruption on every healthy spool.
 */
export function readSpool(text: string | undefined): SpoolContents {
  if (text === undefined || text.length === 0) return { records: [], skipped: 0 };

  const records: SpooledToolCall[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = parseRecord(line);
    if (record === undefined) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

/** Serialises a whole set of records back to spool text. */
export function serialiseSpool(records: readonly SpooledToolCall[]): string {
  return records.map(serialiseRecord).join("");
}

export interface TrimResult {
  readonly records: readonly SpooledToolCall[];
  /** How many were dropped from the front to fit. */
  readonly dropped: number;
}

/**
 * Enforces the ceiling, dropping the oldest.
 *
 * A `maxRecords` of zero or less keeps nothing, which is a legitimate
 * configuration ("spool nothing") and is handled rather than guarded
 * against — the alternative is a special case whose only effect is to make
 * a deliberate zero mean something other than zero.
 */
export function trimSpool(
  records: readonly SpooledToolCall[],
  maxRecords: number = DEFAULT_MAX_RECORDS,
): TrimResult {
  if (maxRecords <= 0) return { records: [], dropped: records.length };
  if (records.length <= maxRecords) return { records, dropped: 0 };
  const dropped = records.length - maxRecords;
  return { records: records.slice(dropped), dropped };
}

/** Splits records into flush-sized batches. */
export function batches(
  records: readonly SpooledToolCall[],
  size: number = DEFAULT_BATCH_SIZE,
): readonly (readonly SpooledToolCall[])[] {
  // A non-positive size would loop forever slicing zero-length batches, so
  // it is normalised to one rather than trusted. This is reachable from
  // configuration, which is exactly the kind of value that arrives wrong.
  const step = size > 0 ? Math.floor(size) : 1;
  const out: (readonly SpooledToolCall[])[] = [];
  for (let index = 0; index < records.length; index += step) {
    out.push(records.slice(index, index + step));
  }
  return out;
}
