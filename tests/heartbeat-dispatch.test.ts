// Dispatch recording and failed-launch detection — MILESTONES.md #60 and
// #62, SCHEMA.md §14.
//
// Two properties carry this suite:
//
//  1. **The prompt contains no live state.** §5 holds the line at "stable
//     instructions in, live state fetched", because a prompt is composed at
//     poll time and read later — anything baked in is a snapshot the agent
//     cannot tell is stale. So the tests assert what the prompt *does not*
//     say as carefully as what it does.
//  2. **A failed launch needs all three conditions.** Dispatched, never
//     claimed, past the threshold. Dropping any one of them produces a
//     check that is either permanently firing or permanently silent, so
//     each is tested by removing it in isolation — including the boundary
//     from both sides, which is where the rule actually lives.

import { describe, expect, it } from "vitest";
import {
  buildDispatchClaimedPayload,
  buildDispatchRecord,
  findFailedLaunches,
  type DispatchObservation,
} from "@/lib/heartbeat/dispatch-record";
import {
  composeLaunchPrompt,
  DISPATCH_REASONS,
  type DispatchReason,
} from "@/lib/heartbeat/launch-prompt";
import type { PlanCandidate } from "@/lib/heartbeat/plan";

const candidate: PlanCandidate = { id: "item-42", priority: "P1", estimatedPoints: 12 };

describe("composeLaunchPrompt — shaped to the situation", () => {
  it("names the item so the prompt is about something", () => {
    const prompt = composeLaunchPrompt({ candidate, reason: "fresh", title: "Fix the importer" });
    expect(prompt).toContain("item-42");
    expect(prompt).toContain("Fix the importer");
  });

  it("still composes a usable prompt with no title", () => {
    const prompt = composeLaunchPrompt({ candidate, reason: "fresh" });
    expect(prompt).toContain("item-42");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("treats an empty title as no title rather than printing a dangling dash", () => {
    // Scoped to the subject line: the body prose legitimately contains
    // em-dashes, so asserting against the whole prompt would pass for the
    // wrong reason and fail the moment the wording changed.
    const [subject] = composeLaunchPrompt({ candidate, reason: "fresh", title: "" }).split("\n\n");
    expect(subject).toBe("Work item `item-42`.");
    expect(subject).not.toContain("—");
  });

  // §5: "fresh start vs rework vs stalled pickup want different briefings".
  // Asserting they *differ* is what makes the enum load-bearing; three
  // reasons that produced identical text would be a distinction with no
  // consequence.
  it("briefs a fresh start, a rework and a stalled pickup differently", () => {
    const prompts = DISPATCH_REASONS.map((reason) =>
      composeLaunchPrompt({ candidate, reason, title: "T" }),
    );
    expect(new Set(prompts).size).toBe(DISPATCH_REASONS.length);
  });

  it("tells a rework that the findings are the brief", () => {
    expect(composeLaunchPrompt({ candidate, reason: "rework" })).toMatch(/findings/i);
  });

  it("tells a stalled pickup to establish where the work got to", () => {
    expect(composeLaunchPrompt({ candidate, reason: "stalled" })).toMatch(/already done|got to/i);
  });

  // ── The line that must not be crossed ─────────────────────────────────
  it("points at orientation rather than quoting live state", () => {
    const prompt = composeLaunchPrompt({ candidate, reason: "fresh", title: "T" });
    expect(prompt).toContain("orientation");
    // The instruction is useless if the agent is not told to distrust the
    // snapshot it is reading, which is the actual mechanism here.
    expect(prompt).toMatch(/do not assume/i);
  });

  it("routes every reason through orientation, not just the fresh one", () => {
    for (const reason of DISPATCH_REASONS) {
      expect(composeLaunchPrompt({ candidate, reason })).toContain("orientation");
    }
  });

  describe("the resume-attempts warning", () => {
    const stalled = (resumeAttempts?: number): string =>
      composeLaunchPrompt({ candidate, reason: "stalled", resumeAttempts });

    it("warns a repeat attempt about its own history", () => {
      expect(stalled(3)).toContain("3 times");
    });

    it("stays silent on a first attempt, which is not a repeat", () => {
      // Nagging on attempt one is what trains an agent to skip the
      // paragraph that matters on attempt three.
      expect(stalled(1)).not.toMatch(/dispatched \d+ times/);
    });

    it("stays silent at zero and when the count is unknown", () => {
      expect(stalled(0)).not.toMatch(/dispatched \d+ times/);
      expect(stalled(undefined)).not.toMatch(/dispatched \d+ times/);
    });

    it("warns from the second attempt, which is the boundary", () => {
      expect(stalled(2)).toContain("2 times");
    });

    it("does not warn a fresh dispatch even if a count is supplied", () => {
      // The warning belongs to the stalled briefing. A fresh start with a
      // stray count is a caller error, not a reason to contradict the
      // opening paragraph.
      expect(composeLaunchPrompt({ candidate, reason: "fresh", resumeAttempts: 5 })).not.toContain(
        "5 times",
      );
    });

    it("ignores a NaN count rather than printing it", () => {
      expect(stalled(Number.NaN)).not.toContain("NaN");
    });
  });
});

describe("buildDispatchRecord — the payload SCHEMA.md §14 names", () => {
  const record = buildDispatchRecord({
    itemId: "item-42",
    machine: "desktop",
    accountId: "account-1",
    estimatedCost: 12,
    prompt: "the composed prompt",
  });

  it("carries machine, account and estimate in the payload", () => {
    expect(record.payload).toEqual({
      machine: "desktop",
      account_id: "account-1",
      estimated_cost: 12,
    });
  });

  it("puts the prompt in the body, not in the payload", () => {
    // §14 is specific about this. A multi-paragraph prompt inside the JSON
    // payload would be read by every consumer that only wanted the machine.
    expect(record.body).toBe("the composed prompt");
    expect(JSON.stringify(record.payload)).not.toContain("the composed prompt");
  });

  it("records the item the dispatch is against", () => {
    expect(record.itemId).toBe("item-42");
  });
});

describe("buildDispatchClaimedPayload — the join key", () => {
  it("carries the dispatch it claims and the session that claimed it", () => {
    expect(
      buildDispatchClaimedPayload({ dispatchEventId: "evt-1", sessionId: "session-9" }),
    ).toEqual({ dispatch_event_id: "evt-1", session_id: "session-9" });
  });
});

// ── #62 ──────────────────────────────────────────────────────────────────
describe("findFailedLaunches — dispatched, never claimed, past the threshold", () => {
  const NOW = 1_000_000;
  const THRESHOLD = 180;
  const thresholdMs = THRESHOLD * 1000;

  const dispatch = (eventId: string, agoMs: number): DispatchObservation => ({
    eventId,
    itemId: `item-for-${eventId}`,
    at: NOW - agoMs,
  });

  const failed = (
    dispatches: readonly DispatchObservation[],
    claimed: readonly string[] = [],
  ): readonly string[] =>
    findFailedLaunches({
      dispatches,
      claimedDispatchEventIds: new Set(claimed),
      now: NOW,
      failedAfterSeconds: THRESHOLD,
    }).map((d) => d.eventId);

  it("reports a dispatch that was never claimed and is well past the threshold", () => {
    expect(failed([dispatch("evt-1", thresholdMs * 2)])).toEqual(["evt-1"]);
  });

  it("says nothing about a dispatch that was claimed instantly", () => {
    expect(failed([dispatch("evt-1", thresholdMs * 2)], ["evt-1"])).toEqual([]);
  });

  it("says nothing about a dispatch claimed late — the launcher still worked", () => {
    // Claim time is deliberately not consulted: the question is whether the
    // launch happened at all, and a slow start is not a failed one.
    expect(failed([dispatch("evt-1", thresholdMs * 10)], ["evt-1"])).toEqual([]);
  });

  // ── The threshold, from both sides and exactly on it ──────────────────
  it("says nothing about an unclaimed dispatch one millisecond before the threshold", () => {
    // The case the brief calls out. Without the elapsed condition this
    // would be reported, and every freshly-written dispatch would look
    // like a failure.
    expect(failed([dispatch("evt-1", thresholdMs - 1)])).toEqual([]);
  });

  it("says nothing about an unclaimed dispatch exactly on the threshold", () => {
    expect(failed([dispatch("evt-1", thresholdMs)])).toEqual([]);
  });

  it("reports an unclaimed dispatch one millisecond past the threshold", () => {
    expect(failed([dispatch("evt-1", thresholdMs + 1)])).toEqual(["evt-1"]);
  });

  it("says nothing about a dispatch written a moment ago", () => {
    // The permanently-firing failure mode, stated directly.
    expect(failed([dispatch("evt-1", 0)])).toEqual([]);
  });

  it("separates the failed from the fine in one mixed batch", () => {
    expect(
      failed(
        [
          dispatch("evt-claimed", thresholdMs * 2),
          dispatch("evt-failed", thresholdMs * 2),
          dispatch("evt-young", 10),
        ],
        ["evt-claimed"],
      ),
    ).toEqual(["evt-failed"]);
  });

  it("reports nothing when there are no dispatches at all", () => {
    expect(failed([])).toEqual([]);
  });

  it("carries the item id, so the answer names what failed", () => {
    const [only] = findFailedLaunches({
      dispatches: [dispatch("evt-1", thresholdMs * 2)],
      claimedDispatchEventIds: new Set(),
      now: NOW,
      failedAfterSeconds: THRESHOLD,
    });
    expect(only?.itemId).toBe("item-for-evt-1");
  });

  it("orders its answer deterministically, whatever order it read them in", () => {
    // This feeds escalation, and an escalation naming its subjects in a
    // different order each run cannot be deduplicated.
    const dispatches = [
      dispatch("evt-c", thresholdMs * 2),
      dispatch("evt-a", thresholdMs * 2),
      dispatch("evt-b", thresholdMs * 2),
    ];
    expect(failed(dispatches)).toEqual(["evt-a", "evt-b", "evt-c"]);
    expect(failed([...dispatches].reverse())).toEqual(["evt-a", "evt-b", "evt-c"]);
  });

  it("does not mutate the caller array", () => {
    const dispatches = [dispatch("evt-c", thresholdMs * 2), dispatch("evt-a", thresholdMs * 2)];
    findFailedLaunches({
      dispatches,
      claimedDispatchEventIds: new Set(),
      now: NOW,
      failedAfterSeconds: THRESHOLD,
    });
    expect(dispatches.map((d) => d.eventId)).toEqual(["evt-c", "evt-a"]);
  });

  it("honours a threshold other than the default", () => {
    // The setting is a parameter, so a configured value must actually
    // change the answer — otherwise the default is silently hardcoded.
    const one = [dispatch("evt-1", 60_000)];
    expect(
      findFailedLaunches({
        dispatches: one,
        claimedDispatchEventIds: new Set(),
        now: NOW,
        failedAfterSeconds: 30,
      }).map((d) => d.eventId),
    ).toEqual(["evt-1"]);
    expect(
      findFailedLaunches({
        dispatches: one,
        claimedDispatchEventIds: new Set(),
        now: NOW,
        failedAfterSeconds: 120,
      }),
    ).toEqual([]);
  });
});

describe("the dispatch reasons are a closed set", () => {
  it("names only the three §5 situations", () => {
    const reasons: readonly DispatchReason[] = DISPATCH_REASONS;
    expect([...reasons]).toEqual(["fresh", "rework", "stalled"]);
  });
});
