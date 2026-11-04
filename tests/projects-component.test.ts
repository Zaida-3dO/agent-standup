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
//   - it must say so in words, quietly, and must NOT carry a warning — an
//     empty project is normal and needs nothing from the reader,
//   - the grid must render every project it was given, the empty ones in
//     their own "Not started" section — hiding them would make the count
//     disagree with what is under it.
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
  // Mirrors the server: `finished` is every terminal state, and `progress`
  // divides by it rather than by `merged`. Defaulting `finished` to `merged`
  // — as this did — reproduced the very bug the card was fixed for inside
  // the fixture, so a card rendering correctly still failed.
  const finished =
    overrides.finished ?? counts.merged + counts.research_done + counts.wont_do + counts.cancelled;
  // The derived values are applied AFTER the spread, so a fixture that sets
  // only `counts` gets a `total` and `merged` consistent with it rather than
  // the defaults — while a fixture that sets them explicitly still wins,
  // because they were read out of `overrides` above.
  return {
    id: "p-1",
    title: "A project",
    headline: null,
    area: "web",
    repo: null,
    priority: "P2",
    finished,
    progress: total === 0 ? null : finished / total,
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
    it("reports CLOSED over total — every terminal state, not merged alone", () => {
      // The bug this card was fixed for. A project with nothing left to do
      // must not read as partly done because the work was closed as
      // `wont_do` or `cancelled` rather than merged: deciding not to build
      // something is a way of finishing it.
      //
      // Breaks if: `aria-valuenow` or the count is fed `merged` — both read
      // 3 instead of 9, and the bar claims two thirds of a finished project
      // is outstanding.
      const tree = ProjectCard({
        project: makeProject({
          counts: { ...noCounts(), merged: 3, wont_do: 4, cancelled: 1, research_done: 1 },
        }),
        now: NOW,
      });

      const bars = progressBars(tree);
      expect(bars).toHaveLength(1);
      expect((bars[0]!.props as { "aria-valuenow": number })["aria-valuenow"]).toBe(9);
      expect((bars[0]!.props as { "aria-valuemax": number })["aria-valuemax"]).toBe(9);
      expect(textOf(tree)).toContain("9 of 9 closed");
      expect(textOf(tree)).toContain("100 %");
    });

    it("prints 99.8%, not 100%, for 880 of 882 closed - and the label, data-percent and bar agree", () => {
      // The reported bug: a card with two children still open read 100%.
      // Four things on the card describe the same ratio and must not
      // contradict one another.
      //
      // Breaks if: the label reads a rounded copy of the percent (it prints
      // 100), `data-percent` is fed a different number from the label, or
      // `aria-valuenow` is fed the percent instead of the closed count.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), merged: 880, executing: 2 } }),
        now: NOW,
      });

      expect(textOf(tree)).toContain("880 of 882 closed");
      expect(textOf(tree)).toContain("99.8 %");
      expect(textOf(tree)).not.toContain("100 %");

      const done = [...walk(tree)].find(
        (element) => (element.props as { "data-band"?: string })["data-band"] === "done",
      )!;
      expect((done.props as { "data-percent": number })["data-percent"]).toBe(99.8);
      // The width is the exact share: it reads 99.77%, so the bar is not
      // drawn full either.
      expect(parseFloat((done.props as { style: { width: string } }).style.width)).toBeCloseTo(
        (880 / 882) * 100,
        6,
      );
      const bar = progressBars(tree)[0]!.props as Record<string, number>;
      expect(bar["aria-valuenow"]).toBe(880);
      expect(bar["aria-valuemax"]).toBe(882);
    });

    it("prints 0.2%, not 0%, for 1 of 500 closed", () => {
      // Breaks if: the label goes back to a whole number - it prints 0.
      const tree = ProjectCard({
        project: makeProject({ counts: { ...noCounts(), merged: 1, executing: 499 } }),
        now: NOW,
      });

      expect(textOf(tree)).toContain("0.2 %");
      const done = [...walk(tree)].find(
        (element) => (element.props as { "data-band"?: string })["data-band"] === "done",
      )!;
      expect((done.props as { "data-percent": number })["data-percent"]).toBe(0.2);
    });

    it("draws ONE bar with a done and a started band, not two bars", () => {
      // Breaks if: the distribution strip comes back — the card then shows
      // the same subtree twice at two denominators, which is what made the
      // top bar readable as "20% left" on a project with nothing left.
      const tree = ProjectCard({
        project: makeProject({
          // 2 done, 1 started, and 6 in the backlog — `on_deck` among them,
          // so this also pins that queued work draws as bare track.
          counts: { ...noCounts(), merged: 2, executing: 1, someday: 3, on_deck: 3 },
        }),
        now: NOW,
      });

      expect(progressBars(tree)).toHaveLength(1);
      // No strip: the twelve-state band row is gone.
      expect(
        [...walk(tree)].filter(
          (element) =>
            (element.props as { "data-segments"?: number })["data-segments"] !== undefined,
        ),
      ).toHaveLength(0);

      const band = (name: string) =>
        [...walk(tree)].find(
          (element) => (element.props as { "data-band"?: string })["data-band"] === name,
        );
      // 2 of 9 done, 1 of 9 started, and the remaining 6 backlog left as
      // bare track — no band is drawn for it.
      expect((band("done")!.props as { style: { width: string } }).style.width).toBe(
        `${(2 / 9) * 100}%`,
      );
      expect((band("started")!.props as { style: { width: string } }).style.width).toBe(
        `${(1 / 9) * 100}%`,
      );
    });

    it("legends the three bands, not twelve states", () => {
      // Breaks if: the legend goes back to mapping over the distribution —
      // "Won't do 4" reappears and a reader is asked to know that it counts
      // as finished.
      //
      // The names are the board's column names on purpose: a reader moving
      // between the card and the board should not have to translate.
      const tree = ProjectCard({
        project: makeProject({
          counts: { ...noCounts(), merged: 2, wont_do: 1, executing: 3, someday: 2, on_deck: 1 },
        }),
        now: NOW,
      });

      const text = textOf(tree).replace(/\s+/g, " ");
      expect(text).toContain("Backlog 3");
      expect(text).toContain("Started 3");
      expect(text).toContain("Done 3");
      expect(text).not.toContain("Won't do");
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
      // Agents are named in plain words, never by their crew name.
      expect(text).toContain("an agent");
      expect(text).not.toContain("Crew One");
      expect(text).not.toContain("Crew Old");
    });

    it("keeps a person holder's name", () => {
      // Breaks if: the plain-words rule is applied to people too.
      const tree = ProjectCard({
        project: makeProject({
          counts: { ...noCounts(), executing: 1 },
          assignments: [
            {
              holderId: "user-a",
              holderType: "person",
              displayName: "Dana",
              role: "builder",
              roleCustom: null,
              liveness: "running",
              lastActive: "2026-08-18T11:00:00.000Z",
            },
          ],
        }),
        now: NOW,
      });
      expect(textOf(tree)).toContain("Dana");
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

    it("says quietly that it is not started, with no warning and no repair link", () => {
      // An empty project needs nothing from the reader, so it must not be
      // flagged. Said in words, because a data attribute alone is invisible.
      //
      // Breaks if: the "Needs attention" badge or the "Repair it" link
      // comes back, or the notice's text is emptied.
      const tree = ProjectCard({ project: childless, now: NOW });

      expect(textOf(tree)).toContain("Not started yet.");
      expect(textOf(tree)).not.toContain("Needs attention");
      expect(textOf(tree)).not.toContain("Repair");
      expect(textOf(tree)).not.toContain("No work under this project");
      const suspect = [...walk(tree)].filter(
        (element) =>
          (element.props as { "data-suspect-reason"?: string })["data-suspect-reason"] !==
          undefined,
      );
      expect(suspect).toHaveLength(0);
    });

    it("links nowhere but the board: the only link is the title", () => {
      // Breaks if: a repair link is re-added inside the empty notice.
      const tree = ProjectCard({ project: childless, now: NOW });
      const links = [...walk(tree)].filter(
        (element) => (element.props as { href?: string }).href !== undefined,
      );
      expect(links).toHaveLength(1);
    });

    it("marks itself childless for the styling hook", () => {
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
  it("renders a card for every project, including the empty ones", () => {
    // Hiding the empty rows would make the count at the top stop matching
    // what is under it.
    //
    // Breaks if: a `.filter((p) => !p.childless)` is dropped without the
    // not-started section picking them up — two cards render instead of three.
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

  /** The elements marked as the quiet section. */
  function notStartedSections(tree: unknown) {
    return [...walk(tree as never)].filter(
      (element) => (element.props as { "data-section"?: string })["data-section"] === "not-started",
    );
  }

  it("puts projects with nothing under them in their own Not started section", () => {
    // Breaks if: the empty projects go back into the main grid, or the
    // section is dropped — the heading and the count disappear.
    const tree = ProjectsView({
      loadState: {
        status: "loaded",
        payload: {
          projects: [
            makeProject({ id: "a", counts: { ...noCounts(), executing: 1 } }),
            makeProject({ id: "b", total: 0, childless: true }),
            makeProject({ id: "c", total: 0, childless: true }),
          ],
          childlessCount: 2,
        },
      },
      now: NOW,
    });

    const [section] = notStartedSections(tree);
    expect(section).toBeDefined();
    const inSection = findAllByType(section, ProjectCard).map(
      (card) => (card.props as { project: ProjectRollup }).project.id,
    );
    expect(inSection.sort()).toEqual(["b", "c"]);
    expect(textOf(section)).toContain("Not started (2)");
    // The main grid holds only the project with work.
    const all = findAllByType(tree, ProjectCard).map(
      (card) => (card.props as { project: ProjectRollup }).project.id,
    );
    expect(all.filter((id) => !inSection.includes(id))).toEqual(["a"]);
  });

  it("raises no warning about empty projects anywhere on the page", () => {
    // Breaks if: an "N with no work under them" tally or a
    // "Needs attention" badge returns to the header.
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

    expect(textOf(tree)).not.toContain("with no work under");
    expect(textOf(tree)).not.toContain("Needs attention");
    const tally = [...walk(tree)].filter(
      (element) =>
        (element.props as { "data-childless-count"?: number })["data-childless-count"] !==
        undefined,
    );
    expect(tally).toHaveLength(0);
  });

  it("shows no Not started section when every project has work", () => {
    // Breaks if: the section renders unconditionally — an empty heading.
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

    expect(notStartedSections(tree)).toHaveLength(0);
    expect(textOf(tree)).not.toContain("Not started");
  });

  it("shows only the quiet section when every project is empty", () => {
    // Breaks if: an empty main grid renders above the section, or the page
    // falls back to "No projects to show." because the main list is empty.
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

    expect(notStartedSections(tree)).toHaveLength(1);
    expect(textOf(tree)).not.toContain("No projects to show.");
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
