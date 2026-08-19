// src/lib/standup/overnight.ts — the overnight report's derivation over an
// events slice, a costs payload, and live assignments. Pure functions over
// plain data, so these run with no DOM and no database.
import { describe, expect, it } from "vitest";
import { buildOvernightReport, defaultCutoff } from "@/lib/standup/overnight";
import type { SinceEvent } from "@/lib/since/types";
import type { CostsPayload } from "@/lib/costs/types";
import type { BoardAssignment } from "@/lib/board/types";

function event(overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "Item A",
    ts: "2026-08-18T10:00:00.000Z",
    actorType: "agent",
    actorId: "builder-one",
    type: "note",
    payload: {},
    body: null,
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function costs(overrides: Partial<CostsPayload> = {}): CostsPayload {
  return { groupBy: "stage", groups: [], truncated: false, unpricedModels: [], ...overrides };
}

function assignment(overrides: Partial<BoardAssignment> = {}): BoardAssignment {
  return {
    holderId: "builder-one",
    holderType: "agent",
    displayName: "Builder One",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

const SINCE = "2026-08-18T00:00:00.000Z";

describe("buildOvernightReport", () => {
  it("counts merge events and newly-blocked state_change events inside the window", () => {
    const events = [
      event({ id: "1", type: "merge", ts: "2026-08-18T05:00:00.000Z" }),
      event({
        id: "2",
        type: "state_change",
        payload: { from: "executing", to: "blocked" },
        ts: "2026-08-18T06:00:00.000Z",
      }),
      // Not a block — moved TO executing, not FROM it.
      event({
        id: "3",
        type: "state_change",
        payload: { from: "planning", to: "executing" },
        ts: "2026-08-18T07:00:00.000Z",
      }),
    ];
    const report = buildOvernightReport(SINCE, events, 200, costs(), []);
    expect(report.merged).toHaveLength(1);
    expect(report.newlyBlocked).toHaveLength(1);
  });

  it("excludes events before the cutoff", () => {
    const events = [event({ id: "1", type: "merge", ts: "2026-08-17T23:00:00.000Z" })];
    const report = buildOvernightReport(SINCE, events, 200, costs(), []);
    expect(report.merged).toHaveLength(0);
  });

  it("includes an event exactly at the cutoff", () => {
    const events = [event({ id: "1", type: "merge", ts: SINCE })];
    const report = buildOvernightReport(SINCE, events, 200, costs(), []);
    expect(report.merged).toHaveLength(1);
  });

  it("counts dead and stalled assignments, and no others", () => {
    const assignments = [
      assignment({ liveness: "running" }),
      assignment({ liveness: "stalled" }),
      assignment({ liveness: "dead" }),
      assignment({ liveness: "superseded" }),
    ];
    const report = buildOvernightReport(SINCE, [], 200, costs(), assignments);
    expect(report.deadOrStalledNow).toBe(2);
  });

  it("sums recomputed cost across groups", () => {
    const payload = costs({
      groups: [
        {
          key: "session-a",
          runs: 1,
          toolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          cost: 1.5,
          unpricedRuns: 0,
        },
        {
          key: "session-b",
          runs: 1,
          toolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          cost: 2.5,
          unpricedRuns: 0,
        },
      ],
    });
    const report = buildOvernightReport(SINCE, [], 200, payload, []);
    expect(report.cost).toBe(4);
  });

  it("reports cost as null rather than zero when nothing could be priced", () => {
    const payload = costs({
      groups: [
        {
          key: "session-a",
          runs: 1,
          toolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          cost: null,
          unpricedRuns: 1,
        },
      ],
    });
    const report = buildOvernightReport(SINCE, [], 200, payload, []);
    expect(report.cost).toBeNull();
  });

  it("flags eventsTruncated when the page came back full and still does not reach the cutoff", () => {
    // requestedLimit is 2, and the page returned exactly 2 rows, none of
    // which is at or before the cutoff — there may be more history before
    // what was fetched.
    const events = [
      event({ id: "1", ts: "2026-08-18T05:00:00.000Z" }),
      event({ id: "2", ts: "2026-08-18T06:00:00.000Z" }),
    ];
    const report = buildOvernightReport(SINCE, events, 2, costs(), []);
    expect(report.eventsTruncated).toBe(true);
  });

  it("does not flag eventsTruncated when the page came back short of the limit", () => {
    // The page returned fewer rows than requested — the read reached the
    // ledger's own start, so there is nothing earlier to have missed.
    const events = [event({ id: "1", ts: "2026-08-18T05:00:00.000Z" })];
    const report = buildOvernightReport(SINCE, events, 200, costs(), []);
    expect(report.eventsTruncated).toBe(false);
  });

  it("does not flag eventsTruncated when the oldest event already reaches the cutoff", () => {
    const events = [
      event({ id: "1", ts: "2026-08-17T23:00:00.000Z" }),
      event({ id: "2", ts: "2026-08-18T05:00:00.000Z" }),
    ];
    const report = buildOvernightReport(SINCE, events, 2, costs(), []);
    expect(report.eventsTruncated).toBe(false);
  });
});

describe("defaultCutoff", () => {
  it("returns 18:00 the same day when now is after 18:00", () => {
    const now = new Date("2026-08-18T20:30:00.000Z");
    const cutoff = new Date(defaultCutoff(now));
    expect(cutoff.getDate()).toBe(now.getDate());
    expect(cutoff.getHours()).toBe(18);
  });

  it("returns 18:00 the previous day when now is before 18:00", () => {
    const now = new Date("2026-08-18T09:00:00.000Z");
    const cutoff = new Date(defaultCutoff(now));
    expect(cutoff.getDate()).toBe(now.getDate() - 1);
    expect(cutoff.getHours()).toBe(18);
  });
});
