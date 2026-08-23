// The Activity tab's own derivations — M10 T10. Plain functions over plain
// data, run with no DOM (`vitest.config.ts`: `environment: "node"`).
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPE_ORDER,
  HISTORY_PAGE_SIZE,
  clampPage,
  dayKeyOf,
  eventTypesPresent,
  filterByType,
  groupByDay,
  pageCount,
  pageOf,
} from "@/lib/item-detail/history";
import type { DetailHistoryEntry } from "@/lib/item-detail/types";

function entry(overrides: Partial<DetailHistoryEntry> = {}): DetailHistoryEntry {
  return {
    id: "1",
    ts: "2026-03-04T05:06:07.000Z",
    type: "state_change",
    actorType: "agent",
    actorId: null,
    sessionId: null,
    body: null,
    payload: null,
    headline: null,
    ...overrides,
  };
}

describe("dayKeyOf", () => {
  it("reads the UTC day of a timestamp", () => {
    expect(dayKeyOf("2026-03-04T23:59:59.000Z")).toBe("2026-03-04");
  });

  it("does not shift across a UTC midnight boundary", () => {
    // The one-character bug this guards: a local-time read here would put
    // 23:59 UTC and 00:01 UTC (the same instant read from two zones) into
    // different groups depending on the reader's timezone.
    expect(dayKeyOf("2026-03-05T00:00:00.000Z")).toBe("2026-03-05");
  });

  it("falls back to the raw string for a value that does not parse", () => {
    expect(dayKeyOf("not-a-date")).toBe("not-a-date");
  });
});

describe("groupByDay", () => {
  it("groups consecutive same-day entries into one group", () => {
    const groups = groupByDay([
      entry({ id: "1", ts: "2026-03-04T10:00:00.000Z" }),
      entry({ id: "2", ts: "2026-03-04T09:00:00.000Z" }),
      entry({ id: "3", ts: "2026-03-03T23:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-04", "2026-03-03"]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["1", "2"]);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(["3"]);
  });

  it("starts a new group even for a day seen earlier, if entries are not sorted", () => {
    // groupByDay does not re-sort — see its own header. Two non-adjacent
    // runs of the same day stay two groups rather than being merged.
    const groups = groupByDay([
      entry({ id: "1", ts: "2026-03-04T10:00:00.000Z" }),
      entry({ id: "2", ts: "2026-03-03T10:00:00.000Z" }),
      entry({ id: "3", ts: "2026-03-04T09:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-04", "2026-03-03", "2026-03-04"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe("eventTypesPresent", () => {
  it("lists only the types actually present", () => {
    const present = eventTypesPresent([
      entry({ type: "escalation" }),
      entry({ type: "checkpoint" }),
      entry({ type: "escalation" }),
    ]);
    expect(present).toEqual(["checkpoint", "escalation"]);
  });

  it("orders by EVENT_TYPE_ORDER, not by first appearance", () => {
    // The one-character bug this guards: if this were derived from
    // insertion order instead, the filter row would reshuffle itself
    // per-item rather than staying in a fixed, learnable order.
    const present = eventTypesPresent([entry({ type: "merge" }), entry({ type: "note" })]);
    const noteIndex = EVENT_TYPE_ORDER.indexOf("note");
    const mergeIndex = EVENT_TYPE_ORDER.indexOf("merge");
    expect(noteIndex).toBeLessThan(mergeIndex);
    expect(present).toEqual(["note", "merge"]);
  });

  it("is empty for no entries", () => {
    expect(eventTypesPresent([])).toEqual([]);
  });
});

describe("filterByType", () => {
  it("returns everything when the filter is null", () => {
    const entries = [entry({ id: "1" }), entry({ id: "2", type: "note" })];
    expect(filterByType(entries, null)).toEqual(entries);
  });

  it("narrows to exactly the matching type", () => {
    const entries = [
      entry({ id: "1", type: "note" }),
      entry({ id: "2", type: "escalation" }),
      entry({ id: "3", type: "note" }),
    ];
    expect(filterByType(entries, "note").map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("is empty when nothing matches", () => {
    expect(filterByType([entry({ type: "note" })], "escalation")).toEqual([]);
  });
});

describe("pageCount / clampPage / pageOf", () => {
  it("computes exactly the pages HISTORY_PAGE_SIZE implies", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(1)).toBe(1);
    expect(pageCount(HISTORY_PAGE_SIZE)).toBe(1);
    expect(pageCount(HISTORY_PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(HISTORY_PAGE_SIZE * 3)).toBe(3);
  });

  it("clamps a negative page to zero", () => {
    expect(clampPage(-1, 5)).toBe(0);
  });

  it("clamps a page past the end to the last real page", () => {
    // The exact scenario `pageOf`'s header names: a page number left over
    // from a wider, unfiltered list must not render empty once a filter
    // narrows the list under that page.
    expect(clampPage(9, 3)).toBe(2);
  });

  it("leaves an in-range page alone", () => {
    expect(clampPage(1, 5)).toBe(1);
  });

  it("slices HISTORY_PAGE_SIZE entries per page", () => {
    const entries = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 3 }, (_, i) =>
      entry({ id: String(i) }),
    );
    const first = pageOf(entries, 0);
    const second = pageOf(entries, 1);
    const third = pageOf(entries, 2);
    expect(first).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second).toHaveLength(HISTORY_PAGE_SIZE);
    expect(third).toHaveLength(3);
    expect(first[0]!.id).toBe("0");
    expect(second[0]!.id).toBe(String(HISTORY_PAGE_SIZE));
  });

  it("degrades a stale page number to the last real page rather than rendering empty", () => {
    const entries = [entry({ id: "1" }), entry({ id: "2" })];
    // Page 50 of a 2-entry list does not exist — pageOf must not return [].
    expect(pageOf(entries, 50)).toEqual(entries);
  });

  it("returns everything on the one page of a short list", () => {
    const entries = [entry({ id: "1" }), entry({ id: "2" })];
    expect(pageOf(entries, 0)).toEqual(entries);
  });
});

describe("EVENT_TYPE_ORDER", () => {
  it("names every EventType exactly once", () => {
    // The mirror this list has to keep with events-insert.ts's own union —
    // a type added there and not here would simply never appear as a
    // filter option, which is the failure this test is positioned to
    // catch structurally: the set sizes disagree the moment one drifts.
    const allTypes: readonly string[] = [
      "field_change",
      "state_change",
      "claim",
      "release",
      "takeover",
      "review_requested",
      "review",
      "merge",
      "dispatch",
      "dispatch_claimed",
      "checkpoint",
      "nudge",
      "escalation",
      "note",
      "setting_change",
      "open_loop",
      "open_loop_closed",
      "open_loop_edited",
      "open_loop_deleted",
    ];
    expect([...EVENT_TYPE_ORDER].sort()).toEqual([...allTypes].sort());
    expect(new Set(EVENT_TYPE_ORDER).size).toBe(EVENT_TYPE_ORDER.length);
  });
});
