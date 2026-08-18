// The digest — MILESTONES.md #128, `docs/plans/INTERVENTIONS.md`
// ("Delivery: a digest, not a drip").
//
// Findings already carry a `timing`, and `evaluate` already resolves it.
// What has been missing is the thing that *acts* on it: a `digest` finding
// rode back on the response exactly as an `immediate` one did, so the field
// described an intention nothing implemented.
//
// ── Why a batch, stated as the failure it avoids ───────────────────────
//
// The design is explicit and it is a claim about attention rather than
// about plumbing: *"a batch arriving at a natural juncture gets acted on
// while a trickle gets skipped, which is exactly the failure to design
// against."* A nudge delivered on the tool call that happened to trigger it
// interrupts something; five nudges delivered together at a pause read as a
// list of things to do. The mechanism's only power is being read, and a
// channel that interrupts constantly is one an agent learns to skim.
//
// ── What this module is, and the line it does not cross ───────────────
//
// This is **accumulation and batching, not delivery**. It holds findings,
// decides when a batch is due, and produces one. It writes no event, opens
// no transaction and reaches no database — for the same reason a predicate
// does not: the moment this module emitted, the digest could only ever be
// delivered the one way it had been taught, and the response field, the
// event row and the front end are three different deliveries of the same
// batch.
//
// **The `nudge` event emitter is deliberately not built here.** That
// channel is a closed four-kind enum (`../hook/nudge.ts` — delegate,
// staging, escalation, wind-down), each kind a *session situation* rather
// than a catalogue finding, and its emitter belongs to the row that owns
// it. Writing intervention findings into it would either widen that enum
// from here — the exact "typo invents a class every later count misses"
// failure it is closed against — or file every finding under a kind that
// does not describe it. So this module produces a batch and stops, and the
// seam is `DigestBatch`: whoever delivers reads that value. Establishing
// where delivery belongs was the point; building the emitter would have
// claimed another row's territory.
//
// ── Time is an argument, never a reading ───────────────────────────────
//
// Nothing here calls `Date.now()`. Every function that needs the time is
// given it, which is what makes "a batch is due five minutes after the
// last one" assertable as a value rather than through a fake clock — and
// keeps this module inside the same purity contract the predicates are held
// to.

import { isBlockingLevel, type InterventionFinding } from "./types";

/**
 * How long a batch accumulates before it is due, in milliseconds.
 *
 * `INTERVENTIONS.md` says "roughly every five minutes", and the roughness
 * is real: this is the interval after which a batch *may* be delivered, not
 * a timer that fires. Nothing here schedules anything — a caller asks
 * whether a batch is due at a moment it was going to be talking to the
 * session anyway, which is what makes the delivery land at a natural
 * juncture instead of interrupting one.
 */
export const DEFAULT_DIGEST_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A finding held for a later batch, with when it was noticed.
 *
 * The timestamp is the finding's own, not the batch's. A digest that
 * reported only when it was assembled would flatten five minutes of
 * findings into one instant, and "this has been true for four minutes" is
 * most of what makes a flow finding worth acting on.
 */
export interface PendingFinding {
  readonly finding: InterventionFinding;
  /** When it was observed, in epoch milliseconds. */
  readonly at: number;
}

/**
 * What a caller delivers.
 *
 * Carries the findings and the window they were gathered over. The window
 * is here because a batch is read as a report — "here is what I noticed" —
 * and a report with no period is one whose reader cannot tell a burst from
 * a slow accumulation.
 */
export interface DigestBatch {
  readonly findings: readonly InterventionFinding[];
  /** When the earliest finding in the batch was observed. */
  readonly from: number;
  /** When the batch was assembled. */
  readonly to: number;
}

/**
 * Whether a finding waits for a batch or goes now.
 *
 * Three conditions, and the third is the one worth stating.
 *
 * `resolveTiming` already forces a blocking level to `immediate`, so a
 * block arriving here carrying `timing: "digest"` describes a state the
 * registry does not produce. **It is refused anyway**, and that is not
 * redundancy for its own sake: this function is the last thing between a
 * finding and a five-minute wait, it is reachable from any caller that
 * assembles a finding itself, and the cost of the two disagreeing is not
 * symmetric. A block deferred to a digest is delivered long after the call
 * it existed to stop — which is indistinguishable, to the session, from
 * never having blocked at all. The same invariant is enforced at four
 * points elsewhere for the same reason: breaking it should take every one
 * of them being wrong at once.
 *
 * A `nothing`-level finding is **not** deferred either: it is recorded and
 * says nothing, so there is nothing to batch. Putting it in a digest would
 * put a silent finding into a message whose entire purpose is to be read.
 */
export function ridesDigest(finding: InterventionFinding): boolean {
  if (finding.timing !== "digest") return false;
  if (finding.level === "nothing") return false;
  return !isBlockingLevel(finding.level);
}

/**
 * Accumulates deferred findings for one session and hands back batches.
 *
 * ── Deliberately in memory, and the consequence is accepted ────────────
 *
 * A process restart loses whatever is pending. That is the right trade for
 * this content: a digest is advisory, its findings are re-detected on the
 * next call that matches, and the alternative — a table written on the
 * highest-volume path in the system — costs a write per finding to protect
 * data whose value expires in five minutes. The one thing it must not do is
 * grow without bound, which `maxPending` below is for.
 */
export class DigestAccumulator {
  private readonly pending = new Map<string, PendingFinding[]>();
  private readonly lastDelivered = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly maxPending: number;

  constructor(options: { intervalMs?: number; maxPending?: number } = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_DIGEST_INTERVAL_MS;
    // A bound rather than unbounded growth. A session that triggers the
    // same finding hundreds of times has a problem the hundredth copy does
    // not describe any better than the first, and an unbounded buffer on a
    // per-tool-call path is a memory leak with a five-minute fuse.
    this.maxPending = options.maxPending ?? 50;
  }

  /**
   * Holds a finding for the next batch. Returns whether it was held.
   *
   * `false` for a finding that does not ride the digest — the caller
   * delivers that one itself — so a call site can route on one call rather
   * than testing the timing and then adding it.
   *
   * **Deduplicated by id.** The same entry triggering repeatedly within one
   * window is one finding, and the *first* is kept rather than the last:
   * the earliest observation is what makes the elapsed time in the batch
   * honest. A finding that arrives twice with different data is still one
   * entry saying one thing about one session.
   */
  add(sessionId: string, finding: InterventionFinding, at: number): boolean {
    if (!ridesDigest(finding)) return false;

    const existing = this.pending.get(sessionId) ?? [];
    if (existing.some((held) => held.finding.id === finding.id)) return true;
    if (existing.length >= this.maxPending) return true;

    existing.push({ finding, at });
    this.pending.set(sessionId, existing);
    return true;
  }

  /** How many findings are held for a session. */
  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  /**
   * Whether a batch is due for this session.
   *
   * Two conditions, both required: something is pending, and the interval
   * has elapsed since the last delivery. A session that has never had one
   * is measured from its earliest pending finding rather than from process
   * start — otherwise the first digest of a long-lived process would be due
   * instantly, reporting a single finding as though it were a batch, which
   * is the drip this exists to avoid wearing a batch's name.
   */
  isDue(sessionId: string, now: number): boolean {
    const held = this.pending.get(sessionId);
    if (held === undefined || held.length === 0) return false;

    const last = this.lastDelivered.get(sessionId);
    const since = last ?? Math.min(...held.map((entry) => entry.at));
    return now - since >= this.intervalMs;
  }

  /**
   * Takes the batch, clearing what it contained.
   *
   * `null` when nothing is due, so a caller asks once rather than testing
   * and then taking — two calls between which the answer could change.
   *
   * Clearing on take is what stops a delivered finding being delivered
   * again. It is re-detected on the next call that triggers it, which is
   * the correct behaviour for a situation that is still true: it reappears
   * in the *next* digest rather than being repeated in every one until
   * somebody fixes it.
   */
  take(sessionId: string, now: number): DigestBatch | null {
    if (!this.isDue(sessionId, now)) return null;

    const held = this.pending.get(sessionId);
    if (held === undefined || held.length === 0) return null;

    this.pending.delete(sessionId);
    this.lastDelivered.set(sessionId, now);

    return {
      findings: held.map((entry) => entry.finding),
      from: Math.min(...held.map((entry) => entry.at)),
      to: now,
    };
  }

  /**
   * Drops everything held for a session.
   *
   * For a session that has ended: its findings are addressed to it, and a
   * batch nobody will read is only a memory cost. Note this does *not*
   * clear `lastDelivered` — a session id that came back would otherwise be
   * instantly due again.
   */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}

/**
 * Renders a batch as the text a session reads.
 *
 * ── Prominence is decided here, and only here ──────────────────────────
 *
 * Every finding carries both a plain and a prominent message, and
 * `INTERVENTIONS.md` puts the choice with the surface rather than the
 * entry. This renders a digest, where the whole batch competes with the
 * work for attention, so it takes `plain` for everything **except** a
 * finding whose entry asked to be prominent by being immediate-but-batched
 * — which cannot happen — meaning: plain throughout. A digest that shouted
 * five times would be a digest nobody finishes reading.
 *
 * A caller that can afford to be loud reads `messages.prominent` off the
 * findings itself; the batch travels intact so that choice stays available.
 */
export function renderDigest(batch: DigestBatch): string {
  if (batch.findings.length === 0) return "";

  const lines = batch.findings.map((finding) => `- ${finding.messages.plain}`);
  const count = batch.findings.length;
  const heading =
    count === 1
      ? "Here is what I noticed since the last digest:"
      : `Here are ${count} things I noticed since the last digest:`;

  return [heading, ...lines].join("\n");
}
