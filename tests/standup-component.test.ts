// The Standup home components (`/`). Hook-free and prop-driven, called
// directly as functions and their returned element trees inspected — same
// technique as `tests/board-view-component.test.ts`.
import { describe, expect, it } from "vitest";
import { StandupHomeView } from "@/components/standup/StandupHomeView";
import { NeedsYouBlock } from "@/components/standup/NeedsYouBlock";
import { InFlightBlock } from "@/components/standup/InFlightBlock";
import { OvernightBlock } from "@/components/standup/OvernightBlock";
import { ProjectsStrip } from "@/components/standup/ProjectsStrip";
import { ErrorState } from "@/components/states/ErrorState";
import type { StandupData, StandupLoadState } from "@/lib/standup/state";
import { findAllByType, findOneByType } from "./helpers/react-element";

function emptyData(): StandupData {
  return {
    overnight: {
      since: "2026-08-18T00:00:00.000Z",
      merged: [],
      newlyBlocked: [],
      deadOrStalledNow: 0,
      cost: null,
      eventsTruncated: false,
    },
    inFlight: [],
    projects: { projects: [], childlessCount: 0 },
    needsYou: [],
  };
}

describe("StandupHomeView — load branches", () => {
  it("shows the error state's message on a failed load", () => {
    const loadState: StandupLoadState = { status: "error", message: "the API said no" };
    const tree = StandupHomeView({ loadState, now: Date.now() });
    const error = findOneByType(tree, ErrorState);
    expect((error.props as { message: string }).message).toBe("the API said no");
  });

  it("renders all four blocks on a loaded state", () => {
    const loadState: StandupLoadState = { status: "loaded", data: emptyData() };
    const tree = StandupHomeView({ loadState, now: Date.now() });
    expect(findAllByType(tree, NeedsYouBlock)).toHaveLength(1);
    expect(findAllByType(tree, InFlightBlock)).toHaveLength(1);
    expect(findAllByType(tree, OvernightBlock)).toHaveLength(1);
    expect(findAllByType(tree, ProjectsStrip)).toHaveLength(1);
  });

  it("passes the loaded data straight through to each block", () => {
    const data = emptyData();
    const loadState: StandupLoadState = { status: "loaded", data };
    const tree = StandupHomeView({ loadState, now: Date.now() });
    expect((findOneByType(tree, OvernightBlock).props as { report: unknown }).report).toBe(
      data.overnight,
    );
    expect((findOneByType(tree, ProjectsStrip).props as { payload: unknown }).payload).toBe(
      data.projects,
    );
  });
});

describe("OvernightBlock", () => {
  it("shows a dash for spend when cost is null, with an explanatory note", () => {
    const tree = OvernightBlock({
      report: {
        since: "2026-08-18T00:00:00.000Z",
        merged: [],
        newlyBlocked: [],
        deadOrStalledNow: 0,
        cost: null,
        eventsTruncated: false,
      },
      now: Date.parse("2026-08-18T12:00:00.000Z"),
    });
    const costCell = findAllByType(tree, "dd").find(
      (el) => (el.props as { "data-stat"?: string })["data-stat"] === "cost",
    );
    expect((costCell!.props as { children: string }).children).toBe("—");
  });

  it("renders a formatted cost figure when one is available", () => {
    const tree = OvernightBlock({
      report: {
        since: "2026-08-18T00:00:00.000Z",
        merged: [{ itemId: "a", itemTitle: "A", ts: "2026-08-18T05:00:00.000Z" }],
        newlyBlocked: [],
        deadOrStalledNow: 0,
        cost: 12.345,
        eventsTruncated: false,
      },
      now: Date.parse("2026-08-18T12:00:00.000Z"),
    });
    const costCell = findAllByType(tree, "dd").find(
      (el) => (el.props as { "data-stat"?: string })["data-stat"] === "cost",
    );
    expect((costCell!.props as { children: string }).children).toBe("~$12.35");
    const mergedCell = findAllByType(tree, "dd").find(
      (el) => (el.props as { "data-stat"?: string })["data-stat"] === "merged",
    );
    expect((mergedCell!.props as { children: number }).children).toBe(1);
  });
});

describe("InFlightBlock", () => {
  it("shows the empty state when nothing is in progress", () => {
    const tree = InFlightBlock({ entries: [] });
    expect(findAllByType(tree, "li")).toHaveLength(0);
  });

  it("flattens multiple assignments on one entry into one row each", () => {
    const tree = InFlightBlock({
      entries: [
        {
          item: {
            id: "item-a",
            title: "Item A",
            headline: null,
            kind: "task",
            state: "executing",
            priority: "P1",
            area: "core",
            repo: null,
            blockedOnPersonId: null,
            blockedOnType: null,
            blockedReason: null,
            pauseReason: null,
          },
          column: "in_progress",
          assignments: [
            {
              holderId: "builder-one",
              holderType: "agent",
              displayName: "Builder One",
              role: "builder",
              roleCustom: null,
              liveness: "running",
              lastActive: "2026-08-18T10:00:00.000Z",
            },
            {
              holderId: "reviewer-one",
              holderType: "agent",
              displayName: "Reviewer One",
              role: "reviewer",
              roleCustom: null,
              liveness: "stalled",
              lastActive: "2026-08-18T09:00:00.000Z",
            },
          ],
          trust: null,
          subtasks: null,
        },
      ],
    });
    const rows = findAllByType(tree, "li");
    expect(rows).toHaveLength(2);
  });
});
