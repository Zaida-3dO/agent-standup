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
