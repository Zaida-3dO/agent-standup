// The batched flush — MILESTONES.md #88, DECISIONS.md §13f ("flushes in
// batches rather than opening a connection per call").
//
// One flush: read the spool, send it in batches, and rewrite the spool with
// exactly what was not accepted. Every effect is a parameter — the spool's
// text in, a `send` function, the new spool text out — so the interesting
// cases (a server that accepts the first batch and dies on the second, a
// spool of pure garbage, a send that throws) are constructed as values.
//
// ── The rule that decides everything else here ─────────────────────────
//
// **Nothing is removed from the spool until the server has said it took
// it.** Telemetry that is deleted on send rather than on acknowledgement is
// telemetry that vanishes on exactly the failure it most needs to survive:
// a server that accepted the connection and then fell over. §10's facet and
// cost history "cannot be backfilled", so a record dropped here is a record
// nobody can ever recover.
//
// The cost of that rule is the opposite failure, and it is worth naming
// rather than discovering: a batch the server *did* store but failed to
// acknowledge — a response lost on the way back — stays on the spool and is
// sent again. So **the flush is at-least-once, not exactly-once**, and
// de-duplication is the ingest's job (#50), not this file's. That is the
// right side to err on: a duplicated tool call is a row someone can
// collapse later, and a lost one is a hole in a measurement nobody can
// reconstruct.
//
// ── Where a failure stops ──────────────────────────────────────────────
//
// A failed batch abandons **that session** and moves on to the next one.
// Within a session it stops at the first failure — those batches are the
// same session's calls in order, and the next one will meet the same
// condition — but one session's refusal is not evidence about another's.
// The reasoning is spelled out at the loop itself, because it is the kind
// of decision that reads as arbitrary without it.

import {
  batches,
  readSpool,
  serialiseSpool,
  trimSpool,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_RECORDS,
} from "./spool";
import type { SpooledToolCall } from "./spool-record";
import type { ToolCallBatch, ToolCallRecord } from "@/lib/telemetry/contract";

/**
 * The wire types come from the shared contract, never from a copy here.
 *
 * `ToolCallRecord` is deliberately **narrower than `SpooledToolCall`**, and
 * the difference is the whole of `toWireCall` below. Because the type is
 * the one the ingest parses against, adding a field to the spool cannot
 * silently start failing every flush: the compiler asks what the wire
 * should do with it, at the one boundary that has to decide.
 */
export type { ToolCallBatch, ToolCallRecord } from "@/lib/telemetry/contract";

/**
 * Reduces one spooled record to what the ingest accepts.
 *
 * Three fields are dropped, for two different reasons, and neither is an
 * omission:
 *
 *   - **`sessionId`** moves to the envelope. It is on every spooled record
 *     because one local file interleaves every session on the machine, but
 *     the request carries it once — so leaving it on the call would be an
 *     unrecognised key, and a redundant one.
 *   - **`model` and `effort`** have no receiver yet. §11 requires the hook
 *     to report them and row **#51** is what will consume them; until that
 *     lands there is no column to put them in, and sending them would fail
 *     the whole batch rather than being ignored. They stay on the spool
 *     (see `SpooledToolCall`), so #51 begins with history rather than with
 *     the day it shipped — capture is the half that cannot be backfilled.
 *
 * **When #51 lands, this function is the one place that changes.** That is
 * why the dropping happens here, in a named function on the wire boundary,
 * rather than being spread across the record builder and the sender.
 */
export function toWireCall(record: SpooledToolCall): ToolCallRecord {
  return {
    tool: record.tool,
    ts: record.ts,
    ...(record.command === undefined ? {} : { command: record.command }),
    ...(record.paths === undefined ? {} : { paths: record.paths }),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    cacheReadTokens: record.cacheReadTokens,
    ...(record.usage5h === undefined ? {} : { usage5h: record.usage5h }),
    ...(record.usageWeekly === undefined ? {} : { usageWeekly: record.usageWeekly }),
  };
}

/**
 * Sends one batch. Resolves `true` when the server took it.
 *
 * `false` for **every** failure — unreachable, a non-success status, a body
 * that could not be read — for the same reason `askServer` collapses its
 * failures in `./ask-http.ts`: they have one consequence here (keep the
 * records and stop), and a caller that had to enumerate them could forget
 * one and treat it as success, which deletes telemetry.
 */
export type SendBatch = (batch: ToolCallBatch) => Promise<boolean>;

export interface FlushOptions {
  /** The spool file's contents, or `undefined` when there is no file. */
  readonly spoolText?: string;
  readonly send: SendBatch;
  readonly batchSize?: number;
  readonly maxRecords?: number;
}

export interface FlushResult {
  /** How many records the server acknowledged. */
  readonly sent: number;
  /** How many are still on the spool afterwards. */
  readonly retained: number;
  /** Lines that could not be read as records; dropped rather than retained. */
  readonly skipped: number;
  /** How many were dropped from the front because the spool was over its ceiling. */
  readonly dropped: number;
  /** Batches attempted, including the one that failed. */
  readonly attempted: number;
  /** True when a batch failed and the flush stopped early. */
  readonly stoppedEarly: boolean;
  /**
   * What the spool file should now contain. Empty string when everything
   * was accepted — written rather than deleted, because a missing file and
   * an empty one are the same state to `readSpool` and rewriting is one
   * operation where deleting-then-recreating is two.
   */
  readonly remaining: string;
}

/**
 * Flushes the spool once.
 *
 * Never throws. A `send` that rejects is treated exactly as one that
 * resolved `false` — the batch stays on the spool and the flush stops —
 * because a flush that propagated an exception would take down whatever
 * called it, and the whole point of spooling is that telemetry cannot
 * affect the thing it is measuring.
 *
 * **Unreadable lines are dropped, not retained.** They are the one thing
 * here that is deliberately discarded: a line that cannot be parsed cannot
 * be sent, so retaining it means keeping it forever and re-skipping it on
 * every flush for the life of the machine. It is counted in the result so
 * the loss is reported rather than silent.
 */
export async function flushSpool(options: FlushOptions): Promise<FlushResult> {
  const { records, skipped } = readSpool(options.spoolText);

  // The ceiling is enforced on the read path as well as the write path.
  // A spool can exceed it without a single append having done so — a build
  // with a larger ceiling wrote the file, or the setting was lowered — and
  // a flush that ignored that would send an unbounded backlog in one go.
  const trimmed = trimSpool(records, options.maxRecords ?? DEFAULT_MAX_RECORDS);

  // Grouped by session before being split into batches, because the request
  // names one session on the envelope. One local spool file holds every
  // session that ran on the machine, so a batch taken as a straight slice
  // would routinely span two of them and there would be no correct
  // `sessionId` to put on it.
  //
  // Order is preserved *within* a session, which is the order that matters:
  // a session's calls stay in the sequence they happened, and sessions are
  // sent in the order they first appear in the file. What is deliberately
  // **not** preserved is global interleaving across sessions — nothing
  // reads it, since every consumer groups by session anyway.
  const bySession = new Map<string, SpooledToolCall[]>();
  for (const record of trimmed.records) {
    const existing = bySession.get(record.sessionId);
    if (existing === undefined) bySession.set(record.sessionId, [record]);
    else existing.push(record);
  }

  const size = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let sent = 0;
  let attempted = 0;
  let stoppedEarly = false;

  // What was acknowledged, tracked as a set rather than as a count.
  //
  // A count was correct while every batch was a contiguous prefix of one
  // list; with per-session grouping it is not — session B's batch can be
  // acknowledged while session A's fails, so "the first N records" no
  // longer describes what landed. Retaining by identity keeps the rule
  // exactly as stated ("nothing leaves the spool until the server says it
  // took it") under grouping, where retaining by position would silently
  // delete a failed session's records because a different session
  // succeeded.
  const acknowledged = new Set<SpooledToolCall>();

  // ── Where a failure stops, and where it does not ──────────────────────
  //
  // A failed batch abandons **that session** and moves to the next one,
  // rather than abandoning the whole flush. The two candidate rules differ
  // only when sessions disagree, and that case decides it:
  //
  //   - Stopping everything treats one session's failure as evidence about
  //     every other session. For an unreachable server that is true, and
  //     costs one wasted request per remaining session — bounded, and
  //     retried on the next flush anyway.
  //   - Continuing treats it as evidence about that session only. For a
  //     server that refuses *one* session's batch — a session id past a
  //     length the server rejects, a record a later build wrote — stopping
  //     would mean that one session's stuck batch blocks every other
  //     session's telemetry indefinitely, and the spool fills to its
  //     ceiling and begins dropping the oldest records of sessions that
  //     were never at fault.
  //
  // The second failure is silent and unbounded; the first is loud and
  // bounded. So the flush continues, and `stoppedEarly` reports that
  // something was left behind.
  //
  // Within one session it still stops at the first failure: those batches
  // are the same session's calls in order, the next one will meet the same
  // condition, and stopping keeps what is retained contiguous.
  for (const [sessionId, sessionRecords] of bySession) {
    for (const batch of batches(sessionRecords, size)) {
      attempted += 1;
      let accepted = false;
      try {
        accepted = await options.send({ sessionId, calls: batch.map(toWireCall) });
      } catch {
        accepted = false;
      }
      if (!accepted) {
        stoppedEarly = true;
        break;
      }
      for (const record of batch) acknowledged.add(record);
      sent += batch.length;
    }
  }

  // Retained in the spool's original order, not the grouped order, so a
  // file that is flushed repeatedly does not get progressively reordered
  // by its own retries.
  const retainedRecords = trimmed.records.filter((record) => !acknowledged.has(record));
  return {
    sent,
    retained: retainedRecords.length,
    skipped,
    dropped: trimmed.dropped,
    attempted,
    stoppedEarly,
    remaining: serialiseSpool(retainedRecords),
  };
}
