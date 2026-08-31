// MILESTONES.md #128 — the digest (`src/lib/interventions/digest.ts`).
//
// The design's claim is about attention rather than plumbing: *"a batch
// arriving at a natural juncture gets acted on while a trickle gets
// skipped, which is exactly the failure to design against."* Every property
// below is one of the ways an implementation quietly turns back into the
// trickle:
//
//   - delivering a finding the moment it arrives (no accumulation),
//   - delivering a batch of one as soon as anything is pending (no interval),
//   - repeating a delivered finding in every later batch (no clearing),
//   - deferring a block, which would arrive after the call it was to stop.
//
// The last is the one with teeth: `resolveTiming` already forces a blocking
// level to `immediate`, and `ridesDigest` must not be a second opinion that
// could disagree with it.
//
// Nothing here fakes a clock. Every function that needs the time is handed
// it, so each of these is an assertion about a value rather than about a
// timer, and the suite has no scheduling in it at all.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIGEST_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  DigestAccumulator,
  renderDigest,
  ridesDigest,
} from "@/lib/interventions/digest";
import type { InterventionFinding } from "@/lib/interventions/types";

function finding(overrides: Partial<InterventionFinding> = {}): InterventionFinding {
  return {
    id: "example",
    source: "builtin",
    phase: "post",
    audience: "orchestrator",
    level: "nudge",
    timing: "digest",
    messages: { plain: "plain text", prominent: "PROMINENT TEXT" },
    ...overrides,
  };
}

describe("which findings ride a digest", () => {
  it("defers a nudge whose timing is digest", () => {
    expect(ridesDigest(finding({ level: "nudge", timing: "digest" }))).toBe(true);
  });

  it("does not defer an immediate finding", () => {
    expect(ridesDigest(finding({ level: "nudge", timing: "immediate" }))).toBe(false);
  });

  it("does not defer a nothing-level finding", () => {
    // `nothing` is recorded and says nothing, so there is no message to
    // batch. Putting one in a digest would put a silent finding into a
    // message whose entire purpose is to be read.
    expect(ridesDigest(finding({ level: "nothing", timing: "digest" }))).toBe(false);
  });

  it("does not defer a block, whatever its timing says", () => {
    // The registry already forces a blocking level to `immediate`, so a
    // block reaching here with `timing: "digest"` is a state that should be
    // unreachable — and this asserts the digest does not create it anyway.
    // A deferred block would be delivered five minutes after the call it
    // was meant to stop, which is the same as not blocking at all.
    for (const level of ["block-overridable", "hard-block"] as const) {
      expect(ridesDigest(finding({ level, timing: "digest" })), level).toBe(false);
    }
  });
});

describe("accumulating findings", () => {
  it("holds a deferred finding rather than delivering it", () => {
    const accumulator = new DigestAccumulator();
    expect(accumulator.add("s1", finding(), 0)).toBe(true);
    expect(accumulator.pendingCount("s1")).toBe(1);
    // Nothing is due yet: the whole point is that it waits.
    expect(accumulator.take("s1", 0)).toBeNull();
  });

  it("declines to hold a finding that does not ride the digest", () => {
    const accumulator = new DigestAccumulator();
    expect(accumulator.add("s1", finding({ timing: "immediate" }), 0)).toBe(false);
    expect(accumulator.pendingCount("s1")).toBe(0);
  });

  it("keeps sessions apart", () => {
    const accumulator = new DigestAccumulator();
    accumulator.add("s1", finding(), 0);
    accumulator.add("s2", finding(), 0);
    // A digest is addressed to a session; delivering one session's findings
    // to another would be telling the wrong reader, which the catalogue
    // names as a way of being ignored.
    expect(accumulator.pendingCount("s1")).toBe(1);
    expect(accumulator.take("s2", DEFAULT_DIGEST_INTERVAL_MS)?.findings).toHaveLength(1);
    expect(accumulator.pendingCount("s1")).toBe(1);
  });

  it("holds one finding per entry within a window", () => {
    const accumulator = new DigestAccumulator();
    accumulator.add("s1", finding({ id: "same" }), 0);
    accumulator.add("s1", finding({ id: "same" }), 1000);
    accumulator.add("s1", finding({ id: "other" }), 2000);
    expect(accumulator.pendingCount("s1")).toBe(2);
  });

  it("keeps the earliest observation of a repeated finding", () => {
    // The elapsed time is most of what makes a flow finding worth acting
    // on. Keeping the last would reset the clock on every repeat, so a
    // situation that had been true for an hour would report as new.
    const accumulator = new DigestAccumulator();
    accumulator.add("s1", finding({ id: "same" }), 0);
    accumulator.add("s1", finding({ id: "same" }), 60_000);
    const batch = accumulator.take("s1", DEFAULT_DIGEST_INTERVAL_MS);
    expect(batch?.from).toBe(0);
  });

  it("stops accumulating at its bound", () => {
    // An unbounded buffer on a per-tool-call path is a memory leak with a
    // five-minute fuse. The hundredth copy of a finding describes the
    // problem no better than the first.
    const accumulator = new DigestAccumulator({ maxPending: 3 });
    for (let index = 0; index < 10; index += 1) {
      accumulator.add("s1", finding({ id: `entry-${index}` }), 0);
    }
    expect(accumulator.pendingCount("s1")).toBe(3);
  });

  it("says plainly that a finding past the bound was not held", () => {
    // The contract is "returns whether it was held", and a caller routing
    // on it would drop the finding entirely if this claimed otherwise —
    // neither delivering it now nor batching it for later.
    const accumulator = new DigestAccumulator({ maxPending: 1 });
    expect(accumulator.add("s1", finding({ id: "first" }), 0)).toBe(true);
    expect(accumulator.add("s1", finding({ id: "second" }), 0)).toBe(false);
    expect(accumulator.pendingCount("s1")).toBe(1);
  });
});

describe("when a batch is due", () => {
  it("is not due before the interval has elapsed", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding(), 0);
    expect(accumulator.isDue("s1", 999)).toBe(false);
    expect(accumulator.take("s1", 999)).toBeNull();
  });

  it("is due once the interval has elapsed", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding(), 0);
    expect(accumulator.isDue("s1", 1000)).toBe(true);
  });

  it("is never due with nothing pending", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    // An empty batch delivered on a schedule is noise that trains a reader
    // to skip the channel — the failure the whole design is against.
    expect(accumulator.isDue("s1", 10_000_000)).toBe(false);
    expect(accumulator.take("s1", 10_000_000)).toBeNull();
  });

  it("measures the first batch from the earliest finding, not from zero", () => {
    // Measuring from process start would make the very first digest due
    // instantly, delivering a single finding as though it were a batch —
    // the drip wearing a batch's name.
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding(), 5_000);
    expect(accumulator.isDue("s1", 5_500)).toBe(false);
    expect(accumulator.isDue("s1", 6_000)).toBe(true);
  });

  it("measures later batches from the last delivery", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding({ id: "first" }), 0);
    expect(accumulator.take("s1", 1000)).not.toBeNull();

    accumulator.add("s1", finding({ id: "second" }), 1100);
    // Due 1000ms after the *delivery*, not after the finding arrived.
    expect(accumulator.isDue("s1", 1500)).toBe(false);
    expect(accumulator.isDue("s1", 2000)).toBe(true);
  });
});

describe("taking a batch", () => {
  it("returns the findings and the window they were gathered over", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding({ id: "a" }), 100);
    accumulator.add("s1", finding({ id: "b" }), 900);

    const batch = accumulator.take("s1", 2000);
    expect(batch?.findings.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(batch?.from).toBe(100);
    expect(batch?.to).toBe(2000);
  });

  it("clears what it delivered", () => {
    // A finding repeated in every batch until somebody fixes it is the
    // nagging that costs the mechanism its only power. A situation that is
    // still true reappears in the *next* digest, re-detected.
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding(), 0);
    accumulator.take("s1", 1000);
    expect(accumulator.pendingCount("s1")).toBe(0);
    expect(accumulator.take("s1", 10_000)).toBeNull();
  });

  it("forgets a session's pending findings", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s1", finding(), 0);
    accumulator.forget("s1");
    expect(accumulator.pendingCount("s1")).toBe(0);
  });
});

describe("rendering a batch", () => {
  it("renders one finding as a single-item report", () => {
    const rendered = renderDigest({ findings: [finding()], from: 0, to: 1000 });
    expect(rendered).toContain("Here is what I noticed");
    expect(rendered).toContain("- plain text");
  });

  it("counts the findings in the heading", () => {
    const rendered = renderDigest({
      findings: [finding({ id: "a" }), finding({ id: "b" })],
      from: 0,
      to: 1000,
    });
    expect(rendered).toContain("Here are 2 things I noticed");
  });

  it("uses the plain message, never the prominent one", () => {
    // Prominence is a property of the message and the choice belongs to the
    // surface. A digest is where the whole batch competes with the work, so
    // it takes the plain form — a batch that shouted five times is one
    // nobody finishes reading. The findings travel intact, so a caller that
    // can afford to be loud still has the choice.
    const rendered = renderDigest({ findings: [finding()], from: 0, to: 1000 });
    expect(rendered).not.toContain("PROMINENT TEXT");
  });

  it("renders an empty batch as nothing at all", () => {
    expect(renderDigest({ findings: [], from: 0, to: 0 })).toBe("");
  });
});

// ── Eviction — the unbounded growth both maps had ───────────────────────
//
// This object lives at module scope for the whole server process, and both
// its maps are keyed by session id. `forget` had no production caller at
// all, and `lastDelivered` was never deleted by anything — including by
// `forget`, which cleared only `pending` — so every distinct session id the
// process ever saw stayed resident for the life of that process.
//
// The tests are written as a pair on purpose: that a stale session goes,
// and that a live one survives the same sweep. A sweep that simply cleared
// everything would pass the first alone, and would be a worse bug than the
// leak — it would silently discard batches a session was still waiting for.
describe("evicting sessions that have gone away", () => {
  const TTL = 10_000;

  it("drops a session that has not been seen within the TTL", () => {
    const accumulator = new DigestAccumulator({ sessionTtlMs: TTL });
    accumulator.add("s-gone", finding(), 0);

    expect(accumulator.sessionCount()).toBe(1);
    accumulator.sweep(TTL + 1);

    expect(accumulator.sessionCount()).toBe(0);
    expect(accumulator.pendingCount("s-gone")).toBe(0);
  });

  // The negative control, and it is written to reach the condition rather
  // than to stop short of it. Both sessions are added, the sweep runs once
  // at a moment that is past the TTL *for one of them only*, and the live
  // session is one whose activity is recent. A sweep that dropped
  // everything, dropped nothing, or compared against the wrong timestamp
  // fails this — it cannot pass by never reaching the comparison.
  it("keeps a session still being seen while dropping a stale one beside it", () => {
    const accumulator = new DigestAccumulator({ sessionTtlMs: TTL });
    accumulator.add("s-stale", finding(), 0);
    // The live session is seen much later, so at sweep time it is inside
    // its TTL while the stale one is well outside it.
    accumulator.add("s-live", finding(), TTL);

    accumulator.sweep(TTL + 1);

    expect(accumulator.pendingCount("s-stale")).toBe(0);
    expect(accumulator.pendingCount("s-live")).toBe(1);
    expect(accumulator.sessionCount()).toBe(1);
  });

  // Kills: an off-by-one that evicts a session at exactly the TTL. The
  // boundary is arbitrary but must match what the constant's name claims —
  // a session is kept while it is not *older* than the TTL.
  it("keeps a session sitting exactly on the TTL boundary", () => {
    const accumulator = new DigestAccumulator({ sessionTtlMs: TTL });
    accumulator.add("s-edge", finding(), 0);

    accumulator.sweep(TTL);

    expect(accumulator.sessionCount()).toBe(1);
  });

  // The leak proper, stated as the number that used to grow forever. Each
  // session is added at a distinct time and the last is far past the first,
  // so all but the most recent are evictable by the time the sweep runs.
  it("does not accumulate one entry per session id seen", () => {
    const accumulator = new DigestAccumulator({ sessionTtlMs: TTL });
    for (let index = 0; index < 50; index += 1) {
      accumulator.add(`s-${index}`, finding(), index * TTL);
    }

    // `add` sweeps as it goes, so the map never held all fifty at once.
    expect(accumulator.sessionCount()).toBeLessThan(50);
  });

  // `lastDelivered` is the map nothing ever deleted from, and it is the one
  // a session reaches only *after* a batch has been taken — so a test that
  // never takes a batch cannot pin it. This takes one, then sweeps, then
  // shows the session is genuinely gone rather than merely emptied of
  // pending findings: a returning id is due on its own fresh window, which
  // is only true if its `lastDelivered` entry went with it.
  it("clears the delivered-at record too, not only the pending findings", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000, sessionTtlMs: TTL });
    accumulator.add("s-1", finding(), 0);
    expect(accumulator.take("s-1", 1000)).not.toBeNull();

    accumulator.sweep(1000 + TTL + 1);
    expect(accumulator.sessionCount()).toBe(0);

    // Back again, long after. Measured from its own first finding rather
    // than from a delivery in the far past, so it is not instantly due.
    const returned = 1_000_000;
    accumulator.add("s-1", finding(), returned);
    expect(accumulator.isDue("s-1", returned)).toBe(false);
    expect(accumulator.isDue("s-1", returned + 1000)).toBe(true);
  });

  // `forget` is the clean-exit path, and it must clear every map. Kills:
  // reverting it to deleting `pending` alone, which is what left the key
  // behind for the life of the process.
  it("forget removes the session from every map", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    accumulator.add("s-1", finding(), 0);
    expect(accumulator.take("s-1", 1000)).not.toBeNull();

    accumulator.forget("s-1");

    expect(accumulator.sessionCount()).toBe(0);
    expect(accumulator.pendingCount("s-1")).toBe(0);
  });

  // The TTL must not be able to evict a session mid-batch: it is only safe
  // because it is far longer than the window a digest accumulates over.
  it("is a TTL far longer than the digest interval", () => {
    expect(DEFAULT_SESSION_TTL_MS).toBeGreaterThan(DEFAULT_DIGEST_INTERVAL_MS);
  });
});
