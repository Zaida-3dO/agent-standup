// The Standup home components (`/`). Hook-free and prop-driven, called
// directly as functions and their returned element trees inspected — same
// technique as `tests/board-view-component.test.ts`.
import { describe, expect, it } from "vitest";
import { SectionError, StandupHomeView } from "@/components/standup/StandupHomeView";
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
      status: "loaded",
      data: {
        since: "2026-08-18T00:00:00.000Z",
        merged: [],
        newlyBlocked: [],
        deadOrStalledNow: 0,
        cost: null,
        costUnavailable: false,
        eventsTruncated: false,
      },
    },
    inFlight: { status: "loaded", data: [] },
    projects: { status: "loaded", data: { projects: [], childlessCount: 0 } },
    needsYou: { status: "loaded", data: [] },
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
      (data.overnight as { data: unknown }).data,
    );
    expect((findOneByType(tree, ProjectsStrip).props as { payload: unknown }).payload).toBe(
      (data.projects as { data: unknown }).data,
    );
  });

  it("renders no section error when every section loaded", () => {
    const tree = StandupHomeView({
      loadState: { status: "loaded", data: emptyData() },
      now: Date.now(),
    });
    expect(findAllByType(tree, SectionError)).toHaveLength(0);
  });
});

describe("StandupHomeView — one section failing", () => {
  const SECTIONS = [
    { key: "overnight", block: OvernightBlock, title: "Last 24 hours" },
    { key: "inFlight", block: InFlightBlock, title: "In flight now" },
    { key: "projects", block: ProjectsStrip, title: "Projects at a glance" },
    { key: "needsYou", block: NeedsYouBlock, title: "Needs you" },
  ] as const;

  for (const failed of SECTIONS) {
    it(`gives the ${failed.key} block its own error line and leaves the rest alone`, () => {
      const data: StandupData = {
        ...emptyData(),
        [failed.key]: { status: "error", message: `${failed.key} read failed` },
      };
      const tree = StandupHomeView({ loadState: { status: "loaded", data }, now: Date.now() });

      const errors = findAllByType(tree, SectionError);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.props).toMatchObject({
        title: failed.title,
        message: `${failed.key} read failed`,
      });
      expect(findAllByType(tree, failed.block)).toHaveLength(0);
      for (const other of SECTIONS.filter((section) => section.key !== failed.key)) {
        expect(findAllByType(tree, other.block), `${other.key} should still render`).toHaveLength(
          1,
        );
      }
    });
  }

  it("shows one error line per failed section when several fail", () => {
    const data: StandupData = {
      ...emptyData(),
      overnight: { status: "error", message: "events refused" },
      projects: { status: "error", message: "projects down" },
    };
    const tree = StandupHomeView({ loadState: { status: "loaded", data }, now: Date.now() });
    const messages = findAllByType(tree, SectionError).map(
      (el) => (el.props as { message: string }).message,
    );
    expect(messages).toEqual(["events refused", "projects down"]);
    expect(findAllByType(tree, NeedsYouBlock)).toHaveLength(1);
    expect(findAllByType(tree, InFlightBlock)).toHaveLength(1);
  });

  it("still renders the page when every section failed, rather than a blank page", () => {
    const failed = { status: "error", message: "down" } as const;
    const data: StandupData = {
      overnight: failed,
      inFlight: failed,
      projects: failed,
      needsYou: failed,
    };
    const tree = StandupHomeView({ loadState: { status: "loaded", data }, now: Date.now() });
    expect(findAllByType(tree, SectionError)).toHaveLength(4);
  });
});

describe("SectionError", () => {
  it("shows the section title and the message", () => {
    const tree = SectionError({ title: "Last 24 hours", message: "Could not load what's new." });
    expect(findAllByType(tree, "h2")).toHaveLength(1);
    expect((findOneByType(tree, ErrorState).props as { message: string }).message).toBe(
      "Could not load what's new.",
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
        costUnavailable: false,
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
        costUnavailable: false,
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

describe("OvernightBlock — figures that could not be loaded", () => {
  const base = {
    since: "2026-08-18T00:00:00.000Z",
    merged: [],
    newlyBlocked: [],
    deadOrStalledNow: 0,
    cost: null,
    costUnavailable: false,
    eventsTruncated: false,
  };
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const stat = (tree: ReturnType<typeof OvernightBlock>, name: string) =>
    findAllByType(tree, "dd").find(
      (el) => (el.props as { "data-stat"?: string })["data-stat"] === name,
    )!;
  const text = (tree: ReturnType<typeof OvernightBlock>) =>
    findAllByType(tree, "p")
      .map((el) => JSON.stringify((el.props as { children: unknown }).children))
      .join(" ");

  it("shows a dash, not zero, for dead or stalled when that read failed", () => {
    const tree = OvernightBlock({ report: { ...base, deadOrStalledNow: null }, now });
    expect((stat(tree, "dead-stalled").props as { children: string }).children).toBe("—");
    expect(text(tree)).toContain("dead or stalled");
  });

  it("shows a real zero when the read succeeded and found none", () => {
    const tree = OvernightBlock({ report: base, now });
    expect((stat(tree, "dead-stalled").props as { children: number }).children).toBe(0);
  });

  it("says spend could not be loaded, rather than that there was no run", () => {
    const tree = OvernightBlock({ report: { ...base, costUnavailable: true }, now });
    expect((stat(tree, "cost").props as { children: string }).children).toBe("—");
    expect(text(tree)).toContain("could not be loaded");
    expect(text(tree)).not.toContain("no run in this window");
  });

  it("keeps the no-run explanation when spend loaded but nothing was priced", () => {
    const tree = OvernightBlock({ report: base, now });
    expect(text(tree)).toContain("no run in this window");
    expect(text(tree)).not.toContain("could not be loaded");
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
