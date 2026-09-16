// The client's half of the wind-down signal — how long this session has
// been quiet, measured locally.
//
// ── Why this is here and not on the server ─────────────────────────────
//
// `shouldSurvey` in `../interventions/survey.ts` tests five conditions, and
// `idleMs` is the one that does the real work: it is what distinguishes the
// last stop of a session from the forty stops before it. Everything else
// only narrows an already-quiet moment.
//
// The server cannot measure it. `hook_decision` is a read operation and
// writes nothing per call, so nothing in the database advances when a
// session makes a tool call. `ToolCall.ts` arrives through the batched
// spool drain, so it dates the last *flush* — a session mid-burst whose
// spool has not drained reads as maximally idle, which would fire the
// survey at the busiest possible moment. `Session.lastSeenAt` advances only
// at registration. The full reasoning, with why each of those is wrong in
// the dangerous direction, is in `../interventions/wind-down-context.ts`.
//
// What *is* synchronous and per-session is the spool file. The hook process
// appends one record to it on every tool call in this session, on this
// machine, before the process exits — `../../bin/standup-hook.ts` does it
// on the line after the verdict is written. So the newest record's
// timestamp is genuinely "when this session last did something", with no
// drain and no round trip in between. That is the clock.
//
// ── Pure, because the hook boundary requires it ────────────────────────
//
// `tests/hook-script-boundaries.test.ts` asserts that nothing under
// `src/lib/hook/**` touches `node:fs` or `process`, and that property is
// what makes every hook decision testable as a value in and a value out.
// So this module takes the spool's *text* and a clock reading as arguments
// and returns a number. The file read is the caller's problem, and the
// caller is already holding a `SpoolStore` for other reasons.
//
// ── Every failure is silence, never a guess ────────────────────────────
//
// An absent spool, an unparseable one, one with no record for this session,
// a timestamp that will not parse, a clock that disagrees with the file —
// every one of these returns `undefined`, and `shouldSurvey` reads an absent
// `idleMs` as "do not ask". The direction is deliberate and it is the same
// direction `readStopContext` errs in: a broken signal costs a missed
// survey, never a spurious one.

import { readSpool } from "./spool";

/**
 * How long this session has been quiet, in milliseconds, or `undefined`
 * when that cannot be established.
 *
 * ── Why the newest record for *this* session, not the newest record ────
 *
 * One machine writes one spool from every session on it. A busy neighbour
 * session would keep the file's newest record perpetually fresh, so reading
 * the file's tail would report that *this* session had just acted whenever
 * any session had. Sessions interleave by default, so that is the normal
 * case rather than an edge one — and it fails silent in the wrong
 * direction, suppressing the survey exactly on the machines that run enough
 * sessions to produce interesting data.
 *
 * ── Why the record's own `ts` and not the file's mtime ─────────────────
 *
 * The mtime answers "when was this file last appended to", which is the
 * neighbour problem again. The record carries the session that wrote it, so
 * filtering is only possible on the record.
 *
 * ── Why a negative result is refused rather than clamped ───────────────
 *
 * A record dated in the future means the two clocks disagree — a corrected
 * system clock, a file copied between machines, a timezone-naive writer.
 * Clamping to zero would report "this session just acted", which is silence
 * and therefore harmless; but it would also report the same thing if the
 * skew were hours, and the next reader would have no way to tell a healthy
 * quiet session from a broken clock. `undefined` says "I could not measure
 * this", which is what actually happened.
 */
export function idleMsFromSpool(options: {
  /** The spool file's contents, or `undefined` if there is no spool yet. */
  readonly spoolText: string | undefined;
  /** The session asking. Only its own records count. */
  readonly sessionId: string;
  /** Epoch milliseconds. Injected so nothing here reads a clock. */
  readonly now: number;
}): number | undefined {
  const { spoolText, sessionId, now } = options;
  if (spoolText === undefined || spoolText === "") return undefined;

  // `readSpool` is the same parser the flush path uses. Reusing it rather
  // than scanning lines here means a record shape this build does not fully
  // recognise is treated identically in both places — and it already
  // tolerates the torn last line that an append-only file written by a
  // process that may be killed will eventually have.
  const { records } = readSpool(spoolText);

  let newest: number | undefined;
  for (const record of records) {
    if (record.sessionId !== sessionId) continue;
    const at = Date.parse(record.ts);
    // `Date.parse` answers `NaN` on anything it cannot read, and `NaN`
    // compares false against everything — so an unparseable timestamp is
    // skipped by the comparison below whether or not it is tested for. It
    // is tested for anyway: relying on `NaN`'s comparison behaviour to
    // implement a validity check is the kind of correctness that survives
    // until someone reorders the expression.
    if (Number.isNaN(at)) continue;
    if (newest === undefined || at > newest) newest = at;
  }

  if (newest === undefined) return undefined;

  const idle = now - newest;
  // See the header: a future-dated record is a clock disagreement, and
  // reporting it as zero would be indistinguishable from a healthy session
  // that just acted.
  if (idle < 0) return undefined;
  return idle;
}

/**
 * Whether this event is one worth paying the spool read for.
 *
 * Only a `Stop`. The read is a whole-file parse and the hook runs on the
 * critical path of every tool call, so doing it on a `PreToolUse` would
 * spend the highest-volume path's budget computing a number that
 * `evaluateStopSurvey` discards on the first line — it returns `null` for
 * any event that is not a `Stop` before it looks at the context at all.
 *
 * Exported and tested rather than inlined as an `if`, because it is the
 * only thing standing between this feature and a measurable cost on every
 * call in the system.
 */
export function shouldMeasureIdle(eventType: string): boolean {
  return eventType === "Stop";
}
