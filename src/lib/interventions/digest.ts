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
 * How long a session's entries are kept after its last activity, in
 * milliseconds.
 *
 * ── Why a TTL, and not only a session-end call ─────────────────────────
 *
 * `forget` exists for the clean case and is worth calling, but it cannot be
 * the mechanism this relies on. Both maps here are keyed by session id and
 * this object lives for the whole server process (`../service/live.ts`
 * holds one at module scope), so anything that fails to remove a key leaks
 * for as long as the process runs. A session ends without saying so
 * routinely — it is killed, it crashes, its `Stop` never arrives, or the
 * process serving that call is not the process that served its last one —
 * and every one of those leaves a key behind forever. Eviction that only
 * works when a session exits politely is eviction that does not work.
 *
 * A TTL needs nothing from the session. Thirty minutes is far longer than
 * the five-minute window a digest is *for*, so it can never evict a session
 * that is still accumulating a batch: an entry only becomes evictable long
 * after any batch it belongs to was deliverable.
 *
 * This bounds the map by *time*, which is the dimension it actually grows
 * in — the existing `maxPending` bounds a single session's findings and
 * does nothing at all about the number of sessions, which is the leak.
 */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

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
  /**
   * When each session was last seen, for the TTL sweep.
   *
   * A third map rather than a timestamp derived from the other two, because
   * neither can answer the question. `pending` is deleted outright by
   * `take`, and `lastDelivered` is only written for a session that has
   * actually had a batch — so a session that accumulated a few findings and
   * left, or one whose batch was taken and never came back, is invisible to
   * both while still holding a key in `lastDelivered`. `lastDelivered` is
   * in fact the more persistent leak of the two: nothing removed a key from
   * it, ever, including `forget`.
   */
  private readonly lastSeen = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly maxPending: number;
  private readonly sessionTtlMs: number;

  constructor(options: { intervalMs?: number; maxPending?: number; sessionTtlMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_DIGEST_INTERVAL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
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
   * than testing the timing and then adding it. `false` **also** when the
   * buffer is full, for the same reason: the answer is "not held", and a
   * caller that believed otherwise would drop it entirely.
   *
   * **Deduplicated by id.** The same entry triggering repeatedly within one
   * window is one finding, and the *first* is kept rather than the last:
   * the earliest observation is what makes the elapsed time in the batch
   * honest. A finding that arrives twice with different data is still one
   * entry saying one thing about one session.
   */
  add(sessionId: string, finding: InterventionFinding, at: number): boolean {
    if (!ridesDigest(finding)) return false;

    // Marked before any early return below, so a session at its bound —
    // which is a busy session, not an absent one — still counts as active
    // and is not evicted out from under itself.
    this.touch(sessionId, at);
    this.sweep(at);

    const existing = this.pending.get(sessionId) ?? [];
    if (existing.some((held) => held.finding.id === finding.id)) return true;
    // At the bound the finding is dropped, and the caller is told so rather
    // than being left to believe it was queued. `true` here would be a lie
    // in the one direction that matters: a caller routing on the return
    // value — which this method's contract invites — would deliver neither
    // now nor later, and the finding would vanish silently. Answering
    // `false` means "not held", which is exactly true, and leaves the
    // caller free to deliver it immediately if it would rather not lose it.
    if (existing.length >= this.maxPending) return false;

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
    this.touch(sessionId, now);

    return {
      findings: held.map((entry) => entry.finding),
      from: Math.min(...held.map((entry) => entry.at)),
      to: now,
    };
  }

  /**
   * Drops everything held for a session that has ended.
   *
   * **All three maps, including `lastDelivered`.** An earlier version
   * cleared only `pending`, reasoning that a session id that came back
   * would otherwise be instantly due again. That reasoning does not survive
   * contact with what a session id is: they are not reused, so the returning
   * session it protected against does not exist, and the effect was a key
   * that was never removed by anything — the leak this method appeared to
   * be the answer to. The protection it was after is real but belongs to
   * live sessions, and `isDue` already provides it by measuring from the
   * earliest pending finding when there is no `lastDelivered` — so a
   * genuinely returning id gets a fresh window rather than an instant batch.
   */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.lastDelivered.delete(sessionId);
    this.lastSeen.delete(sessionId);
  }

  /** Records that a session is active, for the TTL sweep. */
  private touch(sessionId: string, at: number): void {
    this.lastSeen.set(sessionId, at);
  }

  /**
   * Drops every session not seen within the TTL. Returns how many went.
   *
   * Called from `add` and `take` rather than from a timer, deliberately: a
   * timer would keep a handle alive for the life of the process and would
   * run in tests that never asked for it, and this module's whole contract
   * is that time is an argument and nothing here reads a clock. Sweeping on
   * activity means the map is tidied by the same traffic that grows it,
   * and an idle process does no work — the case where its size is already
   * not changing.
   *
   * A session is judged by `lastSeen` alone. Judging by the pending
   * findings' own timestamps would miss exactly the sessions that leak:
   * one whose batch was taken has no pending findings at all, yet still
   * holds keys in `lastDelivered` and here.
   */
  sweep(now: number): number {
    let dropped = 0;
    for (const [sessionId, seen] of this.lastSeen) {
      // `>` and not `>=`: an entry exactly at the TTL has not yet outlived
      // it. The boundary is arbitrary either way, but a session is kept
      // while it is *not older* than the TTL, which is what the constant's
      // name says.
      if (now - seen > this.sessionTtlMs) {
        this.pending.delete(sessionId);
        this.lastDelivered.delete(sessionId);
        this.lastSeen.delete(sessionId);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** How many sessions this accumulator holds. For tests and diagnostics. */
  sessionCount(): number {
    return this.lastSeen.size;
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
