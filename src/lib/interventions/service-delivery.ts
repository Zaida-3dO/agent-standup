// The production deliverer — MILESTONES.md #128.
//
// `./delivery.ts` decides *what* rides back on a response and holds no
// state of its own beyond the accumulator it is handed. This module is the
// one thing that puts a concrete accumulator behind it and hands the
// result to the service runtime, so that `transition_item`,
// `record_artifact`, `note` and `claim` — and every operation added after
// them — carry the field #128 asks for.
//
// ── Why the evaluation here is deliberately narrow ─────────────────────
//
// A service call is not a tool call. It carries no command text and no tool
// name, so every entry keyed on a command's *shape* — I10, I11, I12 — has
// nothing to read and correctly declines. That is not a limitation being
// worked around; it is the reason this path is affordable. `needs()`
// reports nothing needed for a context with no command and no tool, so no
// lookup is even eligible, and the ordinary service response stays exactly
// as cheap as it was before this existed.
//
// What this path *is* for is the digest: findings noticed elsewhere,
// accumulated, and handed over at the moment a session is between two
// pieces of work. A session calling `note` or `transition_item` has just
// finished something — which is the "natural juncture" the design asks for,
// described exactly.
//
// ── What this does NOT do, and why that is the design ──────────────────
//
// It writes no event row. #128 rules that channel out in its own words: the
// `nudge` event enum is a **closed four-kind set owned by #46/#47**, each
// kind a session situation rather than a catalogue finding, so emitting
// into it would either widen an enum this row does not own or file every
// finding under a kind that does not describe it.
//
// It also opens no transaction and holds no database handle. The runtime
// calls it *after* the transaction has closed, so there is nothing to join;
// a deliverer that wanted state would have to be given it, and it is not.

import { DigestAccumulator, renderDigest, type DigestBatch } from "./digest";
import { attachInterventions, decideDelivery, type InterventionPayload } from "./delivery";
import type { InterventionFinding } from "./types";

/** What the runtime hands a deliverer. Mirrors `Caller` without importing it. */
export interface DeliveryCaller {
  readonly sessionId?: string;
}

/**
 * A deliverer bound to one accumulator.
 *
 * Returned as a closure rather than a class so the runtime's option stays a
 * plain function type and a test can substitute any function at all — the
 * runtime should not have to know what kind of object produces a payload.
 */
export interface ServiceDeliverer {
  /** The runtime's hook: result in, result-or-envelope out. */
  (result: unknown, caller: DeliveryCaller): unknown;
  /**
   * Holds findings for a session's next digest.
   *
   * The way findings *enter* this path. They are produced wherever a
   * situation is actually detected — the hook path, or any other producer —
   * and this is where they wait for a juncture at which to be delivered.
   * Separated from the delivery call itself because the two happen at
   * different moments, on different calls, and often for different reasons.
   */
  readonly hold: (sessionId: string, findings: readonly InterventionFinding[], at: number) => void;
  /** Drops what is held for a session that has ended. */
  readonly forget: (sessionId: string) => void;
  /** How many findings are waiting for a session. For tests and diagnostics. */
  readonly pendingCount: (sessionId: string) => number;
}

export interface ServiceDelivererOptions {
  /**
   * The accumulator to batch into. Supplied so a test can construct one
   * with its own interval and bound rather than waiting five real minutes.
   */
  readonly accumulator?: DigestAccumulator;
  /**
   * The clock. Injected for the same reason `./digest.ts` takes time as an
   * argument everywhere: a batch being due five minutes later is then
   * assertable as a value rather than through a fake timer.
   */
  readonly now?: () => number;
}

/**
 * Builds the deliverer the live runtime uses.
 *
 * The accumulator is held in the closure, which is what makes a batch
 * survive between calls without a table — the trade `./digest.ts` records:
 * a digest is advisory, its findings are re-detected, and a per-finding
 * write on this path would cost more than the data is worth.
 */
export function createServiceDeliverer(options: ServiceDelivererOptions = {}): ServiceDeliverer {
  const accumulator = options.accumulator ?? new DigestAccumulator();
  const clock = options.now ?? Date.now;

  const deliver = (result: unknown, caller: DeliveryCaller): unknown => {
    // A call naming no session gets nothing. The accumulator is keyed by
    // session and there is no sensible key for a call without one — a
    // shared bucket would deliver one session's findings to another, which
    // is a worse failure than not batching at all. Answered here as well as
    // in `decideDelivery` because reaching that function at all would mean
    // building a payload for a session that cannot have one.
    const sessionId = caller.sessionId;
    if (sessionId === undefined) return result;

    const payload = decideDelivery(accumulator, { sessionId, now: clock() });
    return attachInterventions(result, payload);
  };

  deliver.hold = (
    sessionId: string,
    findings: readonly InterventionFinding[],
    at: number,
  ): void => {
    for (const finding of findings) accumulator.add(sessionId, finding, at);
  };
  deliver.forget = (sessionId: string): void => accumulator.forget(sessionId);
  deliver.pendingCount = (sessionId: string): number => accumulator.pendingCount(sessionId);

  return deliver;
}

/**
 * Renders a payload for a surface that wants one string.
 *
 * Re-exported through this module so a caller needs one import rather than
 * knowing that rendering lives in `./digest.ts` and assembly in
 * `./delivery.ts`.
 */
export function renderInterventionPayload(payload: InterventionPayload): string | null {
  const parts: string[] = [];
  for (const finding of payload.findings ?? []) {
    if (finding.level !== "nothing") parts.push(finding.messages.plain);
  }
  const digest: DigestBatch | undefined = payload.digest;
  if (digest !== undefined && digest.findings.length > 0) parts.push(renderDigest(digest));
  return parts.length === 0 ? null : parts.join("\n");
}
