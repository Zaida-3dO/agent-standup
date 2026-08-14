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
// ── Stopping on the first failure, rather than continuing ──────────────
//
// When a batch fails, the flush stops instead of trying the ones after it.
// A failing send is overwhelmingly "the server is unreachable" or "the
// server is refusing", and both are conditions the next batch will meet
// too — so continuing spends a request per batch to learn the same thing
// while the hook is holding up a session. Stopping also keeps the spool in
// order: everything from the failed batch onwards is retained as one
// contiguous run, in the order it happened.

import {
  batches,
  readSpool,
  serialiseSpool,
  trimSpool,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_RECORDS,
} from "./spool";
import type { SpooledToolCall } from "./spool-record";

/**
 * Sends one batch. Resolves `true` when the server took it.
 *
 * `false` for **every** failure — unreachable, a non-success status, a body
 * that could not be read — for the same reason `askServer` collapses its
 * failures in `./ask-http.ts`: they have one consequence here (keep the
 * records and stop), and a caller that had to enumerate them could forget
 * one and treat it as success, which deletes telemetry.
 */
export type SendBatch = (batch: readonly SpooledToolCall[]) => Promise<boolean>;

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

  const groups = batches(trimmed.records, options.batchSize ?? DEFAULT_BATCH_SIZE);

  let sent = 0;
  let attempted = 0;
  let stoppedEarly = false;

  for (const batch of groups) {
    attempted += 1;
    let accepted = false;
    try {
      accepted = await options.send(batch);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      stoppedEarly = true;
      break;
    }
    sent += batch.length;
  }

  const retainedRecords = trimmed.records.slice(sent);
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
