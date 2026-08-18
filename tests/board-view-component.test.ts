// The board's components — MILESTONES.md #37. Hook-free and prop-driven
// (see each component's header), so they're called directly as functions
// and their returned element trees inspected — same technique as
// `tests/app-shell-view.test.ts`.
import { describe, expect, it } from "vitest";
import { BoardView } from "@/components/board/BoardView";
import { BoardColumn } from "@/components/board/BoardColumn";
import { ItemCard } from "@/components/board/ItemCard";
import { NeedsYouBadge } from "@/components/board/NeedsYouBadge";
import { emptyBoard } from "@/lib/board/view";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { boardOf, section } from "./helpers/board-sections";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
    // The BLUF (MILESTONES.md #107). Null in the default fixture so a case
    // that cares about it has to say so, rather than every card silently
    // carrying one.
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function entry(column: BoardColumnId, overrides: Partial<BoardItem> = {}): BoardEntry {
  // These fixtures are about drag, tone and tallies; ownership is proved
  // against real data in the operation's own suites. An empty list is what
  // the API sends for an item nobody holds, so it is the honest default.
  return { item: item(overrides), column, assignments: [] };
}

/**
 * A board whose named columns hold the given entries.
 *
 * Takes bare entry lists rather than whole sections: a column's count and
 * cursor (MILESTONES.md #109, #123) are proved against real data in
 * `tests/board-pagination.test.ts`, and restating them at every fixture
 * site here would bury what these tests are actually about.
 */
function boardWith(overrides: Partial<Record<BoardColumnId, readonly BoardEntry[]>> = {}): Board {
  return boardOf(overrides);
}

/** Every string of text anywhere in the tree, flattened — handles arrays of children. */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

describe("BoardView", () => {
  it("shows the error message and no columns when the load failed", () => {
    const element = BoardView({
      loadState: { status: "error", message: "Could not load the board (500)." },
      personId: "user-a",
    });
    expect(textOf(element)).toContain("Could not load the board (500).");
    expect(findAllByType(element, BoardColumn).length).toBe(0);
  });

  it("shows a loading state before the board arrives", () => {
    const element = BoardView({ loadState: { status: "loading" }, personId: "user-a" });
    expect(textOf(element)).toContain("Loading the board");
    expect(findAllByType(element, BoardColumn).length).toBe(0);
  });

  it("renders all four columns once loaded, in board order", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: emptyBoard() },
      personId: null,
    });
    const columns = findAllByType(element, BoardColumn);
    expect(columns.map((c) => (c.props as { column: string }).column)).toEqual([
      "backlog",
      "in_progress",
      "waiting",
      "completed",
    ]);
  });

  it("renders all four columns even when every one of them is empty", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: emptyBoard() },
      personId: null,
    });
    expect(findAllByType(element, BoardColumn).length).toBe(4);
  });

  it("passes the amber/red split to Waiting and to NO other column", () => {
    const element = BoardView({
      loadState: {
        status: "loaded",
        board: boardWith({
          waiting: [
            entry("waiting", { id: "1", state: "paused" }),
            entry("waiting", { id: "2", state: "blocked" }),
          ],
        }),
      },
      personId: null,
    });
    for (const column of findAllByType(element, BoardColumn)) {
      const props = column.props as { column: string; split?: unknown };
      if (props.column === "waiting") {
        expect(props.split).toEqual({ amber: 1, red: 1, other: 0 });
      } else {
        expect(props.split).toBeUndefined();
      }
    }
  });

  it("hands each column its own entries, not the whole board", () => {
    const element = BoardView({
      loadState: {
        status: "loaded",
        board: boardWith({
          backlog: [entry("backlog", { id: "b1" })],
          waiting: [entry("waiting", { id: "w1", state: "paused" })],
        }),
      },
      personId: null,
    });
    const byColumn = new Map(
      findAllByType(element, BoardColumn).map((c) => {
        const props = c.props as { column: string; section: { entries: readonly BoardEntry[] } };
        return [props.column, props.section.entries];
      }),
    );
    expect(byColumn.get("backlog")!.map((e) => e.item.id)).toEqual(["b1"]);
    expect(byColumn.get("waiting")!.map((e) => e.item.id)).toEqual(["w1"]);
    expect(byColumn.get("completed")).toEqual([]);
  });

  it("shows the needs-you badge with the count for the active profile", () => {
    const element = BoardView({
      loadState: {
        status: "loaded",
        board: boardWith({
          waiting: [
            entry("waiting", {
              id: "1",
              state: "blocked",
              blockedOnType: "person",
              blockedOnPersonId: "user-a",
            }),
          ],
        }),
      },
      personId: "user-a",
    });
    expect((findOneByType(element, NeedsYouBadge).props as { count: number }).count).toBe(1);
  });

  it("counts the badge for the ACTIVE profile only — a different profile sees zero", () => {
    const board = boardWith({
      waiting: [
        entry("waiting", {
          id: "1",
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "user-a",
        }),
      ],
    });
    const element = BoardView({ loadState: { status: "loaded", board }, personId: "user-b" });
    expect((findOneByType(element, NeedsYouBadge).props as { count: number }).count).toBe(0);
  });

  it("passes the active profile id down to every column, so cards can be flagged", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: emptyBoard() },
      personId: "user-a",
    });
    for (const column of findAllByType(element, BoardColumn)) {
      expect((column.props as { personId: string | null }).personId).toBe("user-a");
    }
  });
});

describe("NeedsYouBadge", () => {
  it("renders nothing at zero — a '0 need you' badge trains you to stop looking", () => {
    expect(NeedsYouBadge({ count: 0 })).toBeNull();
  });

  it("renders nothing for a negative count", () => {
    expect(NeedsYouBadge({ count: -1 })).toBeNull();
  });

  it("shows the count when there is work", () => {
    expect(textOf(NeedsYouBadge({ count: 3 }))).toContain("3");
  });

  it("uses the singular for one item and the plural for more", () => {
    expect(textOf(NeedsYouBadge({ count: 1 }))).toContain("item needs you");
    expect(textOf(NeedsYouBadge({ count: 2 }))).toContain("items need you");
  });
});

describe("BoardColumn", () => {
  it("shows the column's heading and its card count", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "1" }), entry("backlog", { id: "2" })]),
      personId: null,
    });
    const text = textOf(element);
    expect(text).toContain("Backlog");
    expect(text).toContain("2");
  });

  it("shows an empty state, and no card list, when the column has nothing", () => {
    const element = BoardColumn({ column: "completed", section: section([]), personId: null });
    expect(textOf(element)).toContain("Nothing here.");
    expect(findAllByType(element, ItemCard).length).toBe(0);
  });

  it("renders one card per entry", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "1" }), entry("backlog", { id: "2" })]),
      personId: null,
    });
    expect(findAllByType(element, ItemCard).length).toBe(2);
  });

  it("renders the amber/red tally only when a split is given", () => {
    const withSplit = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
      split: { amber: 2, red: 5, other: 0 },
    });
    // `textOf` joins each element's children with a space, so the count and
    // its label arrive as separate parts of one string — assert on the
    // numbers being present alongside the right labels rather than on the
    // exact spacing the helper happens to produce.
    const text = textOf(withSplit);
    expect(text).toMatch(/2\s+paused/);
    expect(text).toMatch(/5\s+blocked/);

    const without = BoardColumn({ column: "backlog", section: section([]), personId: null });
    expect(textOf(without)).not.toContain("paused");
  });

  it("tallies the `other` bucket too, so the three add up to the header count", () => {
    // `waitingSplit` counts a third bucket — a project in Waiting, whose
    // own state cannot answer its tone. Rendering only amber and red let a
    // card exist in the header count and appear in neither tallied number,
    // which is the "silently goes missing from the count" failure
    // `waitingSplit` says it exists to prevent.
    const element = BoardColumn({
      column: "waiting",
      section: section([
        entry("waiting", { id: "p", kind: "project" }),
        entry("waiting", { id: "a", state: "paused" }),
        entry("waiting", { id: "b", state: "blocked" }),
      ]),
      personId: null,
      split: { amber: 1, red: 1, other: 1 },
    });
    const text = textOf(element);
    expect(text).toMatch(/1\s+other/);
    // The header count and the three tallies agree.
    expect(text).toMatch(/\b3\b/);
  });

  it("hides the `other` tally at zero rather than showing a permanent '0 other'", () => {
    const element = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
      split: { amber: 1, red: 1, other: 0 },
    });
    expect(textOf(element)).not.toContain("other");
  });

  it("flags exactly the cards blocked on the active person", () => {
    const element = BoardColumn({
      column: "waiting",
      section: section([
        entry("waiting", {
          id: "mine",
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "user-a",
        }),
        entry("waiting", {
          id: "theirs",
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "user-b",
        }),
      ]),
      personId: "user-a",
    });
    const flags = findAllByType(element, ItemCard).map((c) => {
      const props = c.props as { entry: BoardEntry; needsYou: boolean };
      return [props.entry.item.id, props.needsYou] as const;
    });
    expect(flags).toEqual([
      ["mine", true],
      ["theirs", false],
    ]);
  });
});

describe("ItemCard", () => {
  it("carries the amber tone for a paused card and the red tone for a blocked one", () => {
    const paused = ItemCard({ entry: entry("waiting", { state: "paused" }), needsYou: false });
    expect((paused.props as { "data-tone"?: string })["data-tone"]).toBe("amber");

    const blocked = ItemCard({ entry: entry("waiting", { state: "blocked" }), needsYou: false });
    expect((blocked.props as { "data-tone"?: string })["data-tone"]).toBe("red");
  });

  it("carries no tone for a card outside Waiting", () => {
    const card = ItemCard({ entry: entry("in_progress", { state: "executing" }), needsYou: false });
    expect((card.props as { "data-tone"?: string })["data-tone"]).toBeUndefined();
  });

  it("shows the title and the priority", () => {
    const card = ItemCard({
      entry: entry("backlog", { title: "Ship the board", priority: "P0" }),
      needsYou: false,
    });
    const text = textOf(card);
    expect(text).toContain("Ship the board");
    expect(text).toContain("P0");
  });

  it("links the title to that item's detail view (#72)", () => {
    // A real link rather than a click handler, so it is middle-clickable,
    // openable in a new tab and reachable by keyboard.
    const card = ItemCard({ entry: entry("backlog", { id: "item-42" }), needsYou: false });
    const links = [...walk(card)].filter(
      (el) => (el.props as { href?: unknown }).href !== undefined,
    );
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href: string }).href).toBe("/items/item-42");
  });

  it("shows the needs-you flag only when the card needs you", () => {
    const flagged = ItemCard({ entry: entry("waiting", { state: "blocked" }), needsYou: true });
    expect(textOf(flagged)).toContain("Needs you");

    const plain = ItemCard({ entry: entry("waiting", { state: "blocked" }), needsYou: false });
    expect(textOf(plain)).not.toContain("Needs you");
  });

  it("shows a paused card's pause reason and a blocked card's blocked reason", () => {
    const paused = ItemCard({
      entry: entry("waiting", { state: "paused", pauseReason: "waiting on the rebuild" }),
      needsYou: false,
    });
    expect(textOf(paused)).toContain("waiting on the rebuild");

    const blocked = ItemCard({
      entry: entry("waiting", { state: "blocked", blockedReason: "needs a decision" }),
      needsYou: false,
    });
    expect(textOf(blocked)).toContain("needs a decision");
  });

  it("does not show a blocked card's reason on a paused card, or vice versa", () => {
    // The two fields are separate in the data; reading the wrong one would
    // silently show a stale reason from an earlier state.
    const paused = ItemCard({
      entry: entry("waiting", {
        state: "paused",
        pauseReason: "the right one",
        blockedReason: "the wrong one",
      }),
      needsYou: false,
    });
    const text = textOf(paused);
    expect(text).toContain("the right one");
    expect(text).not.toContain("the wrong one");
  });

  it("renders no reason line when neither reason is set", () => {
    const card = ItemCard({ entry: entry("backlog", { state: "on_deck" }), needsYou: false });
    expect(textOf(card)).not.toContain("undefined");
    expect(textOf(card)).not.toContain("null");
  });

  it("shows the repo when there is one, and omits it cleanly when there isn't", () => {
    expect(
      textOf(ItemCard({ entry: entry("backlog", { repo: "infra" }), needsYou: false })),
    ).toContain("infra");
    const noRepo = textOf(ItemCard({ entry: entry("backlog", { repo: null }), needsYou: false }));
    expect(noRepo).not.toContain("null");
  });

  it("renders the state readably, without its underscores", () => {
    const card = ItemCard({
      entry: entry("in_progress", { state: "plan_review" }),
      needsYou: false,
    });
    const text = textOf(card);
    expect(text).toContain("plan review");
    expect(text).not.toContain("plan_review");
  });
});
