// Delivering what was noticed — MILESTONES.md #128, the two things that
// row lists as "still missing".
//
// `./digest.ts` accumulates findings and hands back a `DigestBatch`, and
// stops there deliberately: "the batching is done, the channel is the open
// question". This module answers the channel, and answers it once for both
// halves of the gap.
//
// ── The channel, and why it is not an event row ────────────────────────
//
// The obvious-looking channel is `events.type = 'nudge'`, and #128 rules it
// out in its own words: that enum is a **closed four-kind set owned by
// #46/#47** (delegate, staging, escalation, wind-down), each kind a
// *session situation* rather than a catalogue finding. Emitting from here
// would either widen an enum this row does not own, or file every finding
// under a kind that does not describe it. Neither is a delivery; both are a
// mess in somebody else's table.
//
// So the channel is the one #128 names for the *other* gap: **the ordinary
// service response**. "They ride back on the ordinary service response — an
// extra field beside the normal payload on `transition_item`,
// `record_artifact`, `note`, `claim` — **not only through the hook**, which
// decouples the whole feature from the hook being wired."
//
// That single choice closes both gaps with one mechanism, and the reason it
// is the right one rather than merely the convenient one is what a service
// call *is*. The design asks for delivery "at a natural juncture", and
// argues a batch is read where a drip is skipped. A session calling
// `transition_item` or `note` is, by definition, between two pieces of
// work: it has just finished something and is recording it. That is the
// natural juncture, described exactly. The alternative — a timer, a
// background emitter, a row somebody has to poll — would deliver into the
// middle of whatever the session was doing, which is the drip the design
// exists to avoid, wearing a batch's name.
//
// ── What rides, and what does not ──────────────────────────────────────
//
// Two kinds of thing travel on this field, and they are kept distinct in
// the payload because they answer different questions:
//
//   - **`findings`** — what this very call triggered, delivered now. Only
//     `immediate` findings appear here; a `digest`-timed finding is held.
//   - **`digest`** — a batch of findings held from earlier calls, present only when
//     one is actually due. This is the thing that had no channel.
//
// A caller that wants to render loudly still can: the findings travel
// intact, both messages on each, exactly as they do on `hook_decision`.
// Nothing here flattens them to a string, for the same reason
// `hook_decision` does not — prominence belongs to the surface.
//
// ── The cost rule this module is written around ────────────────────────
//
// `hook_decision` is `kind: "read"` and touches no table on the ordinary
// path, and a test pins that against a handle which throws on any query.
// **Attaching interventions to every service response must not undo that**,
// and this module's structure is what keeps it true: it reaches no
// database, holds no handle, and evaluates against a context assembled from
// what the call already carried. A service call has no command text and no
// tool, so `needs()` reports nothing needed and no lookup is even eligible.
//
// The accumulator is in memory, for the reason `./digest.ts` already
// records: a digest is advisory, expires in five minutes, and a table
// written on this path would cost a write per finding to protect it.
//
// ── Time is an argument, never a reading ───────────────────────────────
//
// Nothing here calls `Date.now()` either. The caller supplies `now`, which
// is what makes "a batch is due five minutes later" assertable as a value
// rather than through a fake clock, and keeps this module inside the same
// purity contract `./digest.ts` and the predicates are held to.

import { DigestAccumulator, ridesDigest, type DigestBatch } from "./digest";
import type { InterventionFinding } from "./types";

/**
 * The extra field beside the normal payload.
 *
 * Deliberately its own object rather than fields spread onto the response:
 * an operation's output is its own contract, and merging a `findings` key
 * into it would collide the moment an operation wanted a field by that
 * name. One nested key under a name nothing else uses cannot collide, and a
 * caller that does not care reads straight past it.
 *
 * Both members are optional and the whole object is omitted when neither
 * applies — see `attachInterventions`. An empty envelope on every response
 * would be a field every caller has to learn to ignore.
 */
export interface InterventionPayload {
  /**
   * What this call triggered, to be read now.
   *
   * Only `immediate` findings. Present only when non-empty.
   */
  readonly findings?: readonly InterventionFinding[];
  /**
   * A batch of held findings, delivered because one came due.
   *
   * Present only when `take` actually produced one — a digest that is not
   * due is absent rather than empty, so a caller can route on presence.
   */
  readonly digest?: DigestBatch;
}

/**
 * A response with interventions attached.
 *
 * The operation's own output is preserved under `result` rather than being
 * spread into a new object. Spreading would flatten an output that happens
 * to be an array, silently turn a `null` result into `{}`, and put this
 * module in the business of knowing what every operation returns. Nesting
 * knows nothing about the payload it carries, which is the property that
 * lets it wrap an operation added later.
 */
export interface InterventionEnvelope<T> {
  readonly result: T;
  readonly interventions: InterventionPayload;
}

/**
 * Splits findings into what is delivered now and what is held.
 *
 * The split is `ridesDigest`'s, not a second copy of the rule — which is
 * the point of importing it rather than re-testing `timing === "digest"`
 * here. That function already refuses to defer a blocking finding and
 * refuses to defer a `nothing`-level one, and those refusals are the
 * invariant this module would otherwise be a fifth place to get wrong.
 *
 * **A blocking finding is returned as immediate**, which is the only
 * correct answer on this path and deserves stating. A service response
 * cannot refuse a call the way `PreToolUse` can — the operation has already
 * committed by the time this runs — so a block arriving here is delivered
 * as the strongest possible *message* rather than silently dropped. Dropping
 * it would be the worse failure of the two: the situation the block
 * describes is real whether or not this surface can refuse it.
 */
export function partitionFindings(findings: readonly InterventionFinding[]): {
  immediate: readonly InterventionFinding[];
  deferred: readonly InterventionFinding[];
} {
  const immediate: InterventionFinding[] = [];
  const deferred: InterventionFinding[] = [];

  for (const finding of findings) {
    if (ridesDigest(finding)) deferred.push(finding);
    else immediate.push(finding);
  }

  return { immediate, deferred };
}

/**
 * What a delivery needs to know about the call it is riding on.
 *
 * No database handle and no client, deliberately — the same contract the
 * predicates are held to, for the same reason. A delivery that could fetch
 * would eventually fetch, and it runs on every service call.
 */
export interface DeliveryOptions {
  /** The session the response is going back to. */
  readonly sessionId?: string;
  /** What this call triggered, already evaluated by the registry. */
  readonly findings?: readonly InterventionFinding[];
  /** The moment of the call, in epoch milliseconds. Supplied, never read. */
  readonly now: number;
}

/**
 * Decides what rides back on one service response.
 *
 * Three steps, in this order and for these reasons:
 *
 *   1. **Split** the call's own findings into immediate and deferred.
 *   2. **Hold** the deferred ones for this session. `add` answers whether
 *      it actually held each — it refuses at the bound — and a finding it
 *      declined is promoted to immediate rather than dropped. That is the
 *      contract `DigestAccumulator.add` was written for: "leaves the caller
 *      free to deliver it immediately if it would rather not lose it."
 *   3. **Take** a batch if one is due, and attach it.
 *
 * Step 2 before step 3 is not arbitrary. Taking first would deliver a batch
 * that excluded a finding noticed on this very call, which reads as an
 * omission to anyone comparing the digest against what they just did — and
 * the finding would then wait a further five minutes for a batch it had
 * already missed.
 *
 * **A session with no id gets no digest.** The accumulator is keyed by
 * session, and there is no sensible key for a call that names none — a
 * shared bucket would deliver one session's findings to another, which is
 * a worse failure than not batching. Such a call still gets its immediate
 * findings, because those are about the call rather than about the session.
 */
export function decideDelivery(
  accumulator: DigestAccumulator,
  options: DeliveryOptions,
): InterventionPayload {
  const { immediate, deferred } = partitionFindings(options.findings ?? []);
  const sessionId = options.sessionId;

  if (sessionId === undefined) {
    return immediate.length === 0 ? {} : { findings: immediate };
  }

  // Anything the accumulator declined to hold is delivered now rather than
  // lost. `add` returns false at the bound, and a caller that ignored that
  // would drop the finding entirely — neither now nor later.
  const nowDelivered = [...immediate];
  for (const finding of deferred) {
    if (!accumulator.add(sessionId, finding, options.now)) nowDelivered.push(finding);
  }

  const digest = accumulator.take(sessionId, options.now);

  return {
    ...(nowDelivered.length === 0 ? {} : { findings: nowDelivered }),
    ...(digest === null ? {} : { digest }),
  };
}

/**
 * Whether a payload carries anything worth sending.
 *
 * Exported because the "attach nothing at all" decision is made in two
 * places — here and in the runtime — and one predicate they both call is
 * what stops them disagreeing about what empty means.
 */
export function hasAnything(payload: InterventionPayload): boolean {
  const findings = payload.findings;
  if (findings !== undefined && findings.length > 0) return true;
  const digest = payload.digest;
  return digest !== undefined && digest.findings.length > 0;
}

/**
 * Wraps a result, or leaves it exactly as it was.
 *
 * **The unchanged case returns the original value by identity**, not a copy
 * and not an envelope with an empty payload. That is the overwhelmingly
 * common case — almost every call triggers nothing — and it is what makes
 * this safe to put on every response: a caller that never sees an
 * intervention sees precisely the shape it saw before this existed, so no
 * adapter, no test and no client needs to learn a new shape to keep working.
 *
 * The return type is deliberately a union rather than always-an-envelope
 * for the same reason: a signature promising an envelope would force every
 * existing caller to unwrap one it will almost never receive.
 */
export function attachInterventions<T>(
  result: T,
  payload: InterventionPayload,
): T | InterventionEnvelope<T> {
  if (!hasAnything(payload)) return result;
  return { result, interventions: payload };
}

/**
 * Renders a payload as the text a session reads, or `null` for nothing.
 *
 * A convenience for a surface that wants one string — a command line
 * printing a footer, a hook prepending a line. A surface that can do better
 * reads the structure instead, which is why this is a separate function and
 * not something baked into the payload.
 *
 * Immediate findings come first and the digest after. That order is the
 * one that matches what the reader just did: the immediate finding is about
 * the call they are looking at, and the digest is background. Reversing it
 * would bury the thing they can act on right now under five things they
 * cannot.
 */
export function renderPayload(
  payload: InterventionPayload,
  renderDigest: (batch: DigestBatch) => string,
): string | null {
  const parts: string[] = [];

  const findings = (payload.findings ?? []).filter((finding) => finding.level !== "nothing");
  for (const finding of findings) parts.push(finding.messages.plain);

  const digest = payload.digest;
  if (digest !== undefined && digest.findings.length > 0) parts.push(renderDigest(digest));

  return parts.length === 0 ? null : parts.join("\n");
}
