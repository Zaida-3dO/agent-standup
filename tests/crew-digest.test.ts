// The crew digest — MILESTONES.md #64's third part, DECISIONS.md §6.
//
// The digest is a *briefing, not an alert* (§6), so what these tests pin is
// mostly what it declines to say: `unknown` is never a finding, and nothing
// here concludes that a crewmate is off-track — §6's own honest limit is
// that "pursuing a plausible but wrong approach" is not computable.
import { describe, expect, it } from "vitest";
import {
  anomaliesFor,
  composeCrewDigest,
  DEFAULT_CHECKPOINT_SILENCE_MINUTES,
  type CrewMemberInput,
} from "@/lib/crew/digest";
import type { SessionShape } from "@/lib/telemetry/shape";

function shape(overrides: Partial<SessionShape> = {}): SessionShape {
  return {
    calls: 100,
    repeats: { level: "normal", value: 1, sampleSize: 100 },
    spread: { level: "normal", value: 12, sampleSize: 100 },
    readShare: { level: "normal", value: 55, sampleSize: 100 },
    ...overrides,
  };
}

/**
 * The detail line of the anomaly at `index`, having first asserted there is
 * one.
 *
 * Written this way rather than `anomalies[0]?.detail` because the optional
 * chain is exactly how this assertion would go hollow: on an empty list it
 * yields `undefined`, and `expect(undefined).not.toContain("e.ts")` passes.
 * A test that survives its subject producing nothing at all is not testing
 * the subject.
 */
function detailAt(anomalies: readonly { detail: string }[], index = 0): string {
  const found = anomalies[index];
  if (found === undefined) {
    throw new Error(`Expected an anomaly at index ${index}, but there were ${anomalies.length}.`);
  }
  return found.detail;
}

function member(overrides: Partial<CrewMemberInput> = {}): CrewMemberInput {
  return {
    sessionId: "s1",
    agent: "crewmate",
    itemId: "i1",
    shape: shape(),
    latestCheckpoint: "Building the thing",
    minutesSinceCheckpoint: 2,
    ...overrides,
  };
}

describe("anomaliesFor (#64)", () => {
  // Kills: reporting anomalies on a healthy session.
  it("says nothing about a crewmate with normal signals", () => {
    expect(anomaliesFor(member())).toEqual([]);
  });

  // THE property that keeps a new session readable. Kills: treating
  // `unknown` as elevated, or as a finding of any kind — which would flag
  // every crewmate for its first few tool calls, exactly when a clean
  // reading matters most. `readSessionShape` returns `unknown` below its
  // minimum sample precisely so a consumer can decline to judge.
  it("never reports an anomaly from an unknown signal", () => {
    const unknowns = shape({
      repeats: { level: "unknown", value: 0, sampleSize: 2 },
      spread: { level: "unknown", value: 0, sampleSize: 2 },
      readShare: { level: "unknown", value: 0, sampleSize: 2 },
    });
    expect(anomaliesFor(member({ shape: unknowns }))).toEqual([]);
  });

  // Kills: dropping any one of the three shape-derived anomalies.
  it("reports each elevated signal, with the numbers behind it", () => {
    const repeats = anomaliesFor(
      member({ shape: shape({ repeats: { level: "elevated", value: 9, sampleSize: 100 } }) }),
    );
    expect(repeats.map((a) => a.kind)).toEqual(["repeated-commands"]);
    // The figure is present, not just the verdict — an orchestrator cannot
    // tell a marginal case from a stark one without it, and would have to
    // go and look, which is the hunting the digest exists to replace.
    expect(detailAt(repeats)).toContain("9");

    const spread = anomaliesFor(
      member({ shape: shape({ spread: { level: "elevated", value: 2, sampleSize: 100 } }) }),
    );
    expect(spread.map((a) => a.kind)).toEqual(["narrow-spread"]);

    const reads = anomaliesFor(
      member({ shape: shape({ readShare: { level: "elevated", value: 97, sampleSize: 100 } }) }),
    );
    expect(reads.map((a) => a.kind)).toEqual(["reading-not-writing"]);
    expect(detailAt(reads)).toContain("97");
  });

  // Kills: `>=` mutated to `>` on the silence threshold. Exactly at the
  // threshold counts as silent — asserted on the boundary, since that is
  // the only place the comparison can be wrong.
  it("flags silence at exactly the threshold, not one minute later", () => {
    const at = anomaliesFor(member({ minutesSinceCheckpoint: DEFAULT_CHECKPOINT_SILENCE_MINUTES }));
    expect(at.map((a) => a.kind)).toEqual(["no-checkpoint"]);

    const below = anomaliesFor(
      member({ minutesSinceCheckpoint: DEFAULT_CHECKPOINT_SILENCE_MINUTES - 1 }),
    );
    expect(below).toEqual([]);
  });

  // Kills: collapsing the two silence cases. "Never checkpointed at all" is
  // the more urgent of the two and must not read identically to "went quiet
  // after checkpointing".
  it("distinguishes never-checkpointed from gone-quiet", () => {
    const never = anomaliesFor(member({ latestCheckpoint: null, minutesSinceCheckpoint: 30 }));
    expect(detailAt(never)).toContain("No checkpoint yet");

    const quiet = anomaliesFor(member({ minutesSinceCheckpoint: 30 }));
    expect(detailAt(quiet)).toContain("No checkpoint for 30 minutes");
  });

  // Kills: dropping the out-of-area anomaly, which §6 calls "exact, strong"
  // — the one signal here that is not a threshold judgement.
  it("reports work outside the declared area, bounded in length", () => {
    const many = anomaliesFor(
      member({ pathsOutsideDeclaredArea: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }),
    );
    expect(many.map((a) => a.kind)).toEqual(["outside-declared-area"]);
    expect(detailAt(many)).toContain("and 2 more");
    // The full list must not be dumped into a line meant to be read at a
    // glance.
    expect(detailAt(many)).not.toContain("e.ts");
  });

  // Kills: reporting the anomaly on an empty list.
  it("says nothing when no paths fall outside the declared area", () => {
    expect(anomaliesFor(member({ pathsOutsideDeclaredArea: [] }))).toEqual([]);
  });

  // Kills: crashing or reporting shape anomalies when a session has
  // reported no telemetry at all — a crewmate that has just claimed.
  it("handles a crewmate with no shape reading yet", () => {
    expect(anomaliesFor(member({ shape: null }))).toEqual([]);
  });
});

describe("composeCrewDigest (#64)", () => {
  // Kills: ordering by session id, or not ordering at all. The first line
  // must be the one most worth reading.
  it("puts flagged crewmates first", () => {
    const digest = composeCrewDigest([
      member({ sessionId: "healthy" }),
      member({
        sessionId: "flagged",
        shape: shape({ repeats: { level: "elevated", value: 9, sampleSize: 100 } }),
      }),
    ]);

    expect(digest.members.map((m) => m.sessionId)).toEqual(["flagged", "healthy"]);
    expect(digest.flagged).toBe(1);
  });

  // Kills: breaking the tie arbitrarily. Among equally-flagged crewmates,
  // the one quiet longest is the one to look at first.
  it("breaks a tie by how long a crewmate has been quiet", () => {
    const digest = composeCrewDigest([
      member({ sessionId: "recent", minutesSinceCheckpoint: 1 }),
      member({ sessionId: "stale", minutesSinceCheckpoint: 9 }),
    ]);

    expect(digest.members.map((m) => m.sessionId)).toEqual(["stale", "recent"]);
    expect(digest.flagged).toBe(0);
  });

  // Kills: counting members instead of flagged members.
  it("counts only the flagged", () => {
    const digest = composeCrewDigest([member(), member({ sessionId: "s2" })]);
    expect(digest.members).toHaveLength(2);
    expect(digest.flagged).toBe(0);
  });

  // Kills: carrying `calls` through wrongly, which is how a reader weighs
  // every other number in the line.
  it("reports how many calls each reading was taken over", () => {
    const digest = composeCrewDigest([
      member({ shape: shape({ calls: 137 }) }),
      member({ sessionId: "s2", shape: null }),
    ]);
    expect(digest.members.map((m) => m.calls).sort((a, b) => a - b)).toEqual([0, 137]);
  });

  // An empty crew is a normal state, not an error.
  it("handles an empty crew", () => {
    expect(composeCrewDigest([])).toEqual({ members: [], flagged: 0 });
  });
});
