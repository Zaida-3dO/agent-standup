// M10 T11 — the projects grid's components, called as functions and their
// returned element trees inspected (`tests/helpers/react-element.ts`).
// MILESTONES.md #74.
//
// **What would make this file hollow.** Asserting that a card renders
// *something* proves nothing. The assertions that matter are about what a
// card must NOT do:
//
//   - a childless project must not render a progress bar at all, because a
//     bar at 0% is the false claim this whole row exists to avoid,
//   - it must carry a visible flag, not merely a data attribute,
//   - the grid must render every project it was given, including the broken
//     ones — hiding them is the failure mode named in the task.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { ProjectsView } from "@/components/projects/ProjectsView";
import type { ProjectRollup, StateCounts } from "@/lib/projects/types";
import { ITEM_STATES } from "@/lib/design/tokens";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import { findAllByType, walk } from "./helpers/react-element";

function noCounts(): StateCounts {
  return Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as StateCounts;
}

function makeProject(overrides: Partial<ProjectRollup> = {}): ProjectRollup {
  const counts = { ...noCounts(), ...(overrides.counts ?? {}) };
  const total = overrides.total ?? Object.values(counts).reduce((sum, n) => sum + n, 0);
  const merged = overrides.merged ?? counts.merged;
  // The three derived values are applied AFTER the spread, so a fixture
  // that sets only `counts` gets a `total` and `merged` consistent with it
  // rather than the defaults — while a fixture that sets them explicitly
  // still wins, because they were read out of `overrides` above.
  return {
    id: "p-1",
    title: "A project",
    headline: null,
    area: "web",
    repo: null,
    priority: "P2",
    finished: overrides.finished ?? merged,
    progress: total === 0 ? null : merged / total,
    childless: total === 0,
    lastActivity: "2026-08-18T10:00:00.000Z",
    assignments: [],
    ...overrides,
    counts,
    total,
    merged,
  };
}

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

/** Every string rendered anywhere in the tree, joined — for "does it say X" assertions. */
function textOf(node: unknown): string {
  const parts: string[] = [];
  for (const element of walk(node as never)) {
    const children = (element.props as { children?: unknown }).children;
    const collect = (child: unknown) => {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
      else if (Array.isArray(child)) child.forEach(collect);
    };
    collect(children);
  }
  // Whitespace-normalised, because an interpolation like `{merged} of
  // {total} merged` arrives as four separate children and joining them
  // reintroduces spaces a browser would collapse. Without this, an
  // assertion has to be written against the collector's spacing rather
  // than against what a reader actually sees.
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Every element carrying a `role="progressbar"`. */
function progressBars(node: unknown) {
  return [...walk(node as never)].filter(
    (element) => (element.props as { role?: string }).role === "progressbar",
  );
}

describe("ProjectCard", () => {
  describe("a project with work under it", () => {
    it("renders a progress bar reporting merged over total", () => {
      // Breaks if: `aria-valuenow` is fed anything but `merged` — e.g.
      // `finished`, which is a different number the moment anything is
      // cancelled.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), merged: 3, executing: 6 } }),
        now: NOW,
      });

      const bars = progressBars(tree);
      expect(bars).toHaveLength(1);
      expect((bars[0]!.props as { "aria-valuenow": number })["aria-valuenow"]).toBe(3);
      expect((bars[0]!.props as { "aria-valuemax": number })["aria-valuemax"]).toBe(9);
      expect(textOf(tree)).toContain("3 of 9 merged");
    });

    it("renders one distribution band per state that has children", () => {
      // The spread beneath the rollup — the thing a summary state throws
      // away.
      //
      // Breaks if: the strip maps over `ITEM_STATES` instead of over the
      // computed segments — twelve bands render and this fails.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), merged: 2, executing: 1, blocked: 1 } }),
        now: NOW,
      });

      const strip = [...walk(tree)].find(
        (element) => (element.props as { "data-segments"?: number })["data-segments"] !== undefined,
      );
      expect((strip!.props as { "data-segments": number })["data-segments"]).toBe(3);
    });

    it("shows a live crew count when someone holds it", () => {
      // Breaks if: the count is rendered from `assignments.length` — a
      // superseded row would be counted and this would read 2.
      const tree = ProjectCard({
        project: makeProject({
          counts: { ...noCounts(), executing: 2 },
          assignments: [
            {
              holderId: "crew-one",
              holderType: "agent",
              displayName: "crew-one",
              role: "builder",
              roleCustom: null,
              liveness: "running",
              lastActive: "2026-08-18T11:00:00.000Z",
            },
            {
              holderId: "crew-old",
              holderType: "agent",
              displayName: "crew-old",
              role: "builder",
              roleCustom: null,
              liveness: "superseded",
              lastActive: "2026-08-17T11:00:00.000Z",
            },
          ],
        }),
        now: NOW,
      });

      const crew = [...walk(tree)].find(
        (element) =>
          (element.props as { "data-crew-count"?: number })["data-crew-count"] !== undefined,
      );
      expect((crew!.props as { "data-crew-count": number })["data-crew-count"]).toBe(1);
    });

    it("renders no crew element at all when nobody holds it", () => {
      // "Nobody is on this" should be the absence of a badge, not a badge
      // reading zero.
      //
      // Breaks if: the `crew > 0` guard is removed — a `0` badge renders.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), executing: 1 } }),
        now: NOW,
      });

      const crew = [...walk(tree)].filter(
        (element) =>
          (element.props as { "data-crew-count"?: number })["data-crew-count"] !== undefined,
      );
      expect(crew).toHaveLength(0);
    });

    it("shows a presence row per assignment, including a superseded one — M10 T16", () => {
      // Breaks if: the presence list is filtered to `liveCrewCount`'s
      // running-or-stalled subset instead of rendering every assignment —
      // this would drop the superseded row and read 1 dot instead of 2.
      const tree = ProjectCard({
        project: makeProject({
          counts: { ...noCounts(), executing: 2 },
          assignments: [
            {
              holderId: "crew-one",
              holderType: "agent",
              displayName: "Crew One",
              role: "builder",
              roleCustom: null,
              liveness: "running",
              lastActive: "2026-08-18T11:00:00.000Z",
            },
            {
              holderId: "crew-old",
              holderType: "agent",
              displayName: "Crew Old",
              role: "builder",
              roleCustom: null,
              liveness: "superseded",
              lastActive: "2026-08-17T11:00:00.000Z",
            },
          ],
        }),
        now: NOW,
      });

      const dots = findAllByType(tree, AgentPresenceDot);
      expect(dots).toHaveLength(2);
      expect(dots.map((d) => (d.props as { liveness: string }).liveness)).toEqual([
        "running",
        "superseded",
      ]);
      const text = [...walk(tree)]
        .flatMap((el) => {
          const children = (el.props as { children?: unknown }).children;
          const list = Array.isArray(children) ? children : [children];
          return list.filter((c) => typeof c === "string");
        })
        .join(" ");
      expect(text).toContain("Crew One");
      expect(text).toContain("Crew Old");
    });

    it("renders no presence rows when nobody holds it", () => {
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), executing: 1 } }),
        now: NOW,
      });
      expect(findAllByType(tree, AgentPresenceDot)).toHaveLength(0);
    });
  });

  describe("a childless project", () => {
    const childless = makeProject({ id: "empty", total: 0, merged: 0, childless: true });

    it("renders NO progress bar — not one at zero percent", () => {
      // The single most important assertion in this file. A bar at 0%
      // asserts that work exists and none of it is done; both halves are
      // false for a project with no children.
      //
      // Breaks if: the `project.childless ?` branch is removed — the
      // progress block renders and a progressbar appears.
      const tree = ProjectCard({ project: childless, now: NOW });

      expect(progressBars(tree)).toHaveLength(0);
      expect(textOf(tree)).not.toContain("0%");
    });

    it("says plainly that there is no work under it", () => {
      // Flagged, and flagged in words — a data attribute alone is invisible
      // to the person the flag is for.
      //
      // Breaks if: the notice's text is emptied.
      const tree = ProjectCard({ project: childless, now: NOW });

      expect(textOf(tree)).toContain("No work under this project yet");
      expect(textOf(tree)).toContain("Needs attention");
    });

    it("marks itself childless for the styling that flags it", () => {
      // Breaks if: `data-childless` stops reflecting `project.childless`.
      const tree = ProjectCard({ project: childless, now: NOW });
      const article = [...walk(tree)][0]!;

      expect((article.props as { "data-childless": string })["data-childless"]).toBe("true");
    });

    it("does not mark a project that HAS children as childless", () => {
      // The other half of the discrimination — without it, a constant
      // "true" would pass the test above.
      //
      // Breaks if: `data-childless` is hardcoded.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), executing: 1 } }),
        now: NOW,
      });
      const article = [...walk(tree)][0]!;

      expect((article.props as { "data-childless": string })["data-childless"]).toBe("false");
    });
  });
});

describe("ProjectsView", () => {
  it("renders a card for every project, including the broken ones", () => {
    // Hiding structurally suspect rows is the failure mode this row exists
    // to avoid — the count at the top stops matching what is under it.
    //
    // Breaks if: a `.filter((p) => !p.childless)` is added anywhere on the
    // path — two cards render instead of three.
    const tree = ProjectsView({
      loadState: {
        status: "loaded",
        payload: {
          projects: [
            makeProject({ id: "a", counts: { ...noCounts(), executing: 2 } }),
            makeProject({ id: "b", total: 0, childless: true }),
            makeProject({ id: "c", counts: { ...noCounts(), merged: 1 } }),
          ],
          childlessCount: 1,
        },
      },
      now: NOW,
    });

    expect(findAllByType(tree, ProjectCard)).toHaveLength(3);
  });

  it("surfaces how many projects have no work under them", () => {
    // At the top, so a reader learns how much of the page is affected
    // before reading it as a status report.
    //
    // Breaks if: the `childlessCount > 0` block is removed.
    const tree = ProjectsView({
      loadState: {
        status: "loaded",
        payload: {
          projects: [makeProject({ id: "b", total: 0, childless: true })],
          childlessCount: 1,
        },
      },
      now: NOW,
    });

    const flag = [...walk(tree)].find(
      (element) =>
        (element.props as { "data-childless-count"?: number })["data-childless-count"] !==
        undefined,
    );
    expect((flag!.props as { "data-childless-count": number })["data-childless-count"]).toBe(1);
    expect(textOf(tree)).toContain("with no work under");
  });

  it("shows no childless flag when every project has work", () => {
    // Breaks if: the flag renders unconditionally — it would claim a
    // problem that does not exist.
    const tree = ProjectsView({
      loadState: {
        status: "loaded",
        payload: {
          projects: [makeProject({ id: "a", counts: { ...noCounts(), executing: 1 } })],
          childlessCount: 0,
        },
      },
      now: NOW,
    });

    expect(textOf(tree)).not.toContain("with no work under");
  });

  it("renders the error message, and no cards, when the load failed", () => {
    // An empty result and a failed one must not render identically.
    //
    // Breaks if: the error branch falls through to the grid.
    const tree = ProjectsView({
      loadState: { status: "error", message: "Could not load projects (500)." },
      now: NOW,
    });

    expect(textOf(tree)).toContain("Could not load projects (500).");
    expect(findAllByType(tree, ProjectCard)).toHaveLength(0);
  });

  it("says it is loading, and renders no cards, while loading", () => {
    // Breaks if: the loading branch is removed — it would fall through and
    // read `loadState.payload` on a state that has none.
    const tree = ProjectsView({ loadState: { status: "loading" }, now: NOW });

    expect(textOf(tree)).toContain("Loading projects…");
    expect(findAllByType(tree, ProjectCard)).toHaveLength(0);
  });

  it("distinguishes an empty result from a failed one", () => {
    // Breaks if: the empty branch is removed — the grid renders with no
    // cards and says nothing, which reads as a broken page.
    const tree = ProjectsView({
      loadState: { status: "loaded", payload: { projects: [], childlessCount: 0 } },
      now: NOW,
    });

    expect(textOf(tree)).toContain("No projects to show.");
  });
});
