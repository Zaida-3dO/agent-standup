// src/lib/fleet/view.ts — the fleet page's display derivations (M10 T16):
// grouping by liveness, filtering by machine/agent, relative-time labels,
// and the dead-but-unswept flag.
//
// Pure functions over plain data, so these run with no DOM and no database.
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import {
  agentsOf,
  ageMsOf,
  filterFleet,
  groupByLiveness,
  isOverdueForSweep,
  livenessLabel,
  LIVENESS_BANDS,
  machinesOf,
  NO_FLEET_FILTERS,
  relativeTime,
} from "@/lib/fleet/view";
import type { FleetAssignment } from "@/lib/fleet/types";

function assignment(overrides: Partial<FleetAssignment> = {}): FleetAssignment {
  return {
    holderId: "gary",
    holderType: "agent",
    displayName: "Gary",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-08-18T10:00:00.000Z",
    id: "asn-1",
    machine: "calliope",
    branch: "feat/x",
    worktree: "/wt/x",
    model: "sonnet",
    effort: "medium",
    sessionId: "sess-1",
    rootSessionId: "sess-1",
    pid: 123,
    claimedAt: "2026-08-18T09:00:00.000Z",
    releasedAt: null,
    itemId: "item-1",
    itemTitle: "Ship the thing",
    itemKind: "task",
    itemState: "executing",
    ...overrides,
  };
}

describe("groupByLiveness", () => {
  it("returns all four bands even when every one is empty", () => {
    // Breaks if: bands are filtered to only those with matches — the whole
    // point is a reader sees "Dead (0)" rather than the band disappearing.
    const groups = groupByLiveness([]);
    expect(groups.map((g) => g.liveness)).toEqual(LIVENESS_BANDS);
    expect(groups.every((g) => g.assignments.length === 0)).toBe(true);
  });

  it("buckets each assignment under its own liveness, in band order", () => {
    const rows = [
      assignment({ id: "a1", liveness: "dead" }),
      assignment({ id: "a2", liveness: "running" }),
      assignment({ id: "a3", liveness: "superseded" }),
      assignment({ id: "a4", liveness: "stalled" }),
    ];
    const groups = groupByLiveness(rows);
    expect(groups.find((g) => g.liveness === "running")!.assignments.map((a) => a.id)).toEqual([
      "a2",
    ]);
    expect(groups.find((g) => g.liveness === "stalled")!.assignments.map((a) => a.id)).toEqual([
      "a4",
    ]);
    expect(groups.find((g) => g.liveness === "dead")!.assignments.map((a) => a.id)).toEqual(["a1"]);
    expect(groups.find((g) => g.liveness === "superseded")!.assignments.map((a) => a.id)).toEqual([
      "a3",
    ]);
  });

  it("labels every liveness value distinctly", () => {
    const labels = LIVENESS_BANDS.map(livenessLabel);
    expect(new Set(labels).size).toBe(4);
  });
});

describe("machinesOf / agentsOf", () => {
  it("returns every distinct machine, sorted, with no duplicates", () => {
    const rows = [
      assignment({ machine: "clyde" }),
      assignment({ machine: "calliope" }),
      assignment({ machine: "calliope" }),
    ];
    expect(machinesOf(rows)).toEqual(["calliope", "clyde"]);
  });

  it("returns every distinct agent display name, sorted, with no duplicates", () => {
    const rows = [
      assignment({ displayName: "Priya" }),
      assignment({ displayName: "Gary" }),
      assignment({ displayName: "Gary" }),
    ];
    expect(agentsOf(rows)).toEqual(["Gary", "Priya"]);
  });
});

describe("filterFleet", () => {
  const rows = [
    assignment({ id: "a1", machine: "calliope", displayName: "Gary" }),
    assignment({ id: "a2", machine: "clyde", displayName: "Gary" }),
    assignment({ id: "a3", machine: "calliope", displayName: "Priya" }),
  ];

  it("returns every row when no filter is set", () => {
    expect(filterFleet(rows, NO_FLEET_FILTERS).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("narrows by machine alone", () => {
    expect(filterFleet(rows, { machine: "calliope", agent: null }).map((a) => a.id)).toEqual([
      "a1",
      "a3",
    ]);
  });

  it("narrows by agent alone", () => {
    expect(filterFleet(rows, { machine: null, agent: "Gary" }).map((a) => a.id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("applies both filters together (AND, not OR)", () => {
    // Breaks if: the two conditions are combined with || instead of && —
    // a3 (calliope/Priya) would then match "calliope" OR "Gary" and appear.
    expect(filterFleet(rows, { machine: "calliope", agent: "Gary" }).map((a) => a.id)).toEqual([
      "a1",
    ]);
  });
});

describe("relativeTime", () => {
  it("floors to the nearest whole unit, matching projects/view.ts's own boundaries", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    expect(relativeTime("2026-08-18T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-18T10:00:00.000Z", now)).toBe("2h ago");
    expect(relativeTime("2026-08-15T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("reports unknown rather than 'Invalid Date' for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", Date.now())).toBe("unknown");
  });
});

describe("ageMsOf", () => {
  it("computes the millisecond age from lastActive to now", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    expect(ageMsOf("2026-08-18T11:00:00.000Z", now)).toBe(60 * 60 * 1000);
  });

  it("never goes negative on clock skew", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    expect(ageMsOf("2026-08-18T13:00:00.000Z", now)).toBe(0);
  });
});

describe("isOverdueForSweep — the dead-but-unswept flag", () => {
  const deadAfterSeconds = 1800; // 30 minutes
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("flags a running row whose lastActive is already past the dead threshold", () => {
    // Breaks if: the comparison uses > instead of >= — an assignment
    // exactly at the threshold would read as not-yet-overdue.
    const stale = assignment({
      liveness: "running",
      lastActive: "2026-08-18T11:29:00.000Z", // 31 minutes ago
    });
    expect(isOverdueForSweep(stale, now, deadAfterSeconds)).toBe(true);
  });

  it("does not flag a running row still within the threshold", () => {
    const fresh = assignment({
      liveness: "running",
      lastActive: "2026-08-18T11:50:00.000Z", // 10 minutes ago
    });
    expect(isOverdueForSweep(fresh, now, deadAfterSeconds)).toBe(false);
  });

  it("does not flag an already-dead row — it is dead, not overdue for becoming dead", () => {
    const dead = assignment({
      liveness: "dead",
      lastActive: "2026-08-18T10:00:00.000Z",
    });
    expect(isOverdueForSweep(dead, now, deadAfterSeconds)).toBe(false);
  });

  it("does not flag a superseded row — a takeover already resolved it", () => {
    const superseded = assignment({
      liveness: "superseded",
      lastActive: "2026-08-18T10:00:00.000Z",
    });
    expect(isOverdueForSweep(superseded, now, deadAfterSeconds)).toBe(false);
  });

  it("flags a stalled row past the threshold too, not just running ones", () => {
    const stale = assignment({
      liveness: "stalled",
      lastActive: "2026-08-18T11:00:00.000Z", // 60 minutes ago
    });
    expect(isOverdueForSweep(stale, now, deadAfterSeconds)).toBe(true);
  });
});
