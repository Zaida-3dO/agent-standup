// The board's components — MILESTONES.md #37. Hook-free and prop-driven
// (see each component's header), so they're called directly as functions
// and their returned element trees inspected — same technique as
// `tests/app-shell-view.test.ts`.
import { describe, expect, it } from "vitest";
import { BoardView } from "@/components/board/BoardView";
import { BoardColumn } from "@/components/board/BoardColumn";
import { ItemCard } from "@/components/board/ItemCard";
import { NeedsYouBadge } from "@/components/board/NeedsYouBadge";
import { TrustBadge } from "@/components/chips/TrustBadge";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { emptyBoard } from "@/lib/board/view";
import type {
  Board,
  BoardAssignment,
  BoardColumnId,
  BoardEntry,
  BoardItem,
} from "@/lib/board/types";
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

function entry(
  column: BoardColumnId,
  overrides: Partial<BoardItem> = {},
  trust: BoardEntry["trust"] = null,
): BoardEntry {
  // These fixtures are about drag, tone and tallies; ownership is proved
  // against real data in the operation's own suites. An empty list is what
  // the API sends for an item nobody holds, so it is the honest default.
  // `trust` defaults to `null` (the project case) — a test that cares about
  // the trust marker passes it explicitly.
  return { item: item(overrides), column, assignments: [], trust };
}

/** A `BoardAssignment` fixture — presence tests below build their own list of these. */
function assignment(overrides: Partial<BoardAssignment> = {}): BoardAssignment {
  return {
    holderId: "gary",
    holderType: "agent",
    displayName: "Gary",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
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
  // The error and loading branches delegate to the shared state components
  // (`@/components/states`), so what is asserted here is that the branch
  // reaches the right component and hands it the right props — the components'
  // own rendering is proved in `tests/shared-states-component.test.ts`.
  it("hands the failing read's message to the shared error state, and renders no columns", () => {
    const element = BoardView({
      loadState: { status: "error", message: "Could not load the board (500)." },
      personId: "user-a",
      now: 0,
    });
    const error = findOneByType(element, ErrorState);
    // The message is passed through UNCHANGED — it is the one that names the
    // failing call, and a component that rewrote it would be reintroducing
    // "something went wrong" one layer down.
    expect((error.props as { message: string }).message).toBe("Could not load the board (500).");
    expect(findAllByType(element, BoardColumn).length).toBe(0);
  });

  it("offers a retry on the error state when the caller gave one", () => {
    let retried = 0;
    const element = BoardView({
      loadState: { status: "error", message: "Could not load the board (500)." },
      personId: "user-a",
      now: 0,
      onRetry: () => {
        retried++;
      },
    });
    const error = findOneByType(element, ErrorState);
    (error.props as { onRetry?: () => void }).onRetry?.();
    expect(retried).toBe(1);
  });

  it("shows skeleton columns, not a sentence, before the board arrives", () => {
    const element = BoardView({ loadState: { status: "loading" }, personId: "user-a", now: 0 });
    // All four columns are drawn while loading — the board's shape is known
    // before its contents are, which is what stops the page jumping when the
    // data lands. Every one of them is in its loading state.
    const columns = findAllByType(element, BoardColumn);
    expect(columns.length).toBe(4);
    expect(columns.every((c) => (c.props as { loading?: boolean }).loading === true)).toBe(true);
  });

  it("renders all four columns once loaded, in board order", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: emptyBoard() },
      personId: null,
      now: 0,
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
      now: 0,
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
      now: 0,
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
      now: 0,
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
      now: 0,
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
    const element = BoardView({
      loadState: { status: "loaded", board },
      personId: "user-b",
      now: 0,
    });
    expect((findOneByType(element, NeedsYouBadge).props as { count: number }).count).toBe(0);
  });

  it("passes the active profile id down to every column, so cards can be flagged", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: emptyBoard() },
      personId: "user-a",
      now: 0,
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
      now: 0,
    });
    const text = textOf(element);
    expect(text).toContain("Backlog");
    expect(text).toContain("2");
  });

  it("shows the shared empty state, and no card list, when the column has nothing", () => {
    const element = BoardColumn({
      column: "completed",
      section: section([]),
      personId: null,
      now: 0,
    });
    // `empty` specifically, not merely "an empty state" — a column with
    // nothing in it and a column that was not fetched both have zero
    // entries, and #123 is what happens when they render the same.
    expect((findOneByType(element, EmptyState).props as { kind: string }).kind).toBe("empty");
    expect(findAllByType(element, ItemCard).length).toBe(0);
  });

  it("renders one card per entry", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "1" }), entry("backlog", { id: "2" })]),
      personId: null,
      now: 0,
    });
    expect(findAllByType(element, ItemCard).length).toBe(2);
  });

  it("renders the amber/red tally only when a split is given", () => {
    const withSplit = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
      now: 0,
      split: { amber: 2, red: 5, other: 0 },
    });
    // `textOf` joins each element's children with a space, so the count and
    // its label arrive as separate parts of one string — assert on the
    // numbers being present alongside the right labels rather than on the
    // exact spacing the helper happens to produce.
    const text = textOf(withSplit);
    expect(text).toMatch(/2\s+paused/);
    expect(text).toMatch(/5\s+blocked/);

    const without = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      now: 0,
    });
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
      now: 0,
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
      now: 0,
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
      now: 0,
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
    const paused = ItemCard({
      entry: entry("waiting", { state: "paused" }),
      needsYou: false,
      now: 0,
    });
    expect((paused.props as { "data-tone"?: string })["data-tone"]).toBe("amber");

    const blocked = ItemCard({
      entry: entry("waiting", { state: "blocked" }),
      needsYou: false,
      now: 0,
    });
    expect((blocked.props as { "data-tone"?: string })["data-tone"]).toBe("red");
  });

  it("carries no tone for a card outside Waiting", () => {
    const card = ItemCard({
      entry: entry("in_progress", { state: "executing" }),
      needsYou: false,
      now: 0,
    });
    expect((card.props as { "data-tone"?: string })["data-tone"]).toBeUndefined();
  });

  it("shows the title and the priority", () => {
    const card = ItemCard({
      entry: entry("backlog", { title: "Ship the board", priority: "P0" }),
      needsYou: false,
      now: 0,
    });
    const text = textOf(card);
    expect(text).toContain("Ship the board");
    expect(text).toContain("P0");
  });

  // MILESTONES.md #131: the card leads with `headline` where one exists.
  it("leads with the headline, not the imported title, when one is written", () => {
    const card = ItemCard({
      entry: entry("backlog", {
        title: "agent-standup #102 - route the four raw event writes",
        headline: "Route event writes through appendEvent",
      }),
      needsYou: false,
      now: 0,
    });
    const link = [...walk(card)].find((el) => (el.props as { href?: unknown }).href !== undefined);
    expect(textOf(link!)).toBe("Route event writes through appendEvent");
  });

  // Fails if the title is dropped from the response rather than demoted —
  // the whole point is that nothing is lost, only re-ordered.
  it("still shows the source title, demoted, once a headline stands in for it", () => {
    const card = ItemCard({
      entry: entry("backlog", {
        title: "agent-standup #102 - route the four raw event writes",
        headline: "Route event writes through appendEvent",
      }),
      needsYou: false,
      now: 0,
    });
    expect(textOf(card)).toContain("agent-standup #102 - route the four raw event writes");
  });

  // Fails if the card prints the title twice once headline stops being null.
  it("does not show the source title a second time when there is no headline", () => {
    const card = ItemCard({
      entry: entry("backlog", { title: "Ship the board", headline: null }),
      needsYou: false,
      now: 0,
    });
    const text = textOf(card);
    expect(text.match(/Ship the board/g)).toHaveLength(1);
  });

  it("links the title to that item's detail view (#72)", () => {
    // A real link rather than a click handler, so it is middle-clickable,
    // openable in a new tab and reachable by keyboard.
    const card = ItemCard({ entry: entry("backlog", { id: "item-42" }), needsYou: false, now: 0 });
    const links = [...walk(card)].filter(
      (el) => (el.props as { href?: unknown }).href !== undefined,
    );
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href: string }).href).toBe("/items/item-42");
  });

  it("shows the needs-you flag only when the card needs you", () => {
    const flagged = ItemCard({
      entry: entry("waiting", { state: "blocked" }),
      needsYou: true,
      now: 0,
    });
    expect(textOf(flagged)).toContain("Needs you");

    const plain = ItemCard({
      entry: entry("waiting", { state: "blocked" }),
      needsYou: false,
      now: 0,
    });
    expect(textOf(plain)).not.toContain("Needs you");
  });

  it("shows a paused card's pause reason and a blocked card's blocked reason", () => {
    const paused = ItemCard({
      entry: entry("waiting", { state: "paused", pauseReason: "waiting on the rebuild" }),
      needsYou: false,
      now: 0,
    });
    expect(textOf(paused)).toContain("waiting on the rebuild");

    const blocked = ItemCard({
      entry: entry("waiting", { state: "blocked", blockedReason: "needs a decision" }),
      needsYou: false,
      now: 0,
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
      now: 0,
    });
    const text = textOf(paused);
    expect(text).toContain("the right one");
    expect(text).not.toContain("the wrong one");
  });

  it("renders no reason line when neither reason is set", () => {
    const card = ItemCard({
      entry: entry("backlog", { state: "on_deck" }),
      needsYou: false,
      now: 0,
    });
    expect(textOf(card)).not.toContain("undefined");
    expect(textOf(card)).not.toContain("null");
  });

  it("shows the repo when there is one, and omits it cleanly when there isn't", () => {
    expect(
      textOf(ItemCard({ entry: entry("backlog", { repo: "infra" }), needsYou: false, now: 0 })),
    ).toContain("infra");
    const noRepo = textOf(
      ItemCard({ entry: entry("backlog", { repo: null }), needsYou: false, now: 0 }),
    );
    expect(noRepo).not.toContain("null");
  });

  it("renders the state readably, without its underscores", () => {
    const card = ItemCard({
      entry: entry("in_progress", { state: "plan_review" }),
      needsYou: false,
      now: 0,
    });
    const text = textOf(card);
    expect(text).toContain("plan review");
    expect(text).not.toContain("plan_review");
  });

  // MILESTONES.md #131 — the trust marker.
  describe("trust marker", () => {
    it("shows no trust badge for a project (trust: null)", () => {
      const card = ItemCard({ entry: entry("backlog", {}, null), needsYou: false, now: 0 });
      expect(findAllByType(card, TrustBadge)).toHaveLength(0);
    });

    // `TrustBadge` is a nested component — it appears in `ItemCard`'s
    // returned tree as an unrendered reference, so its own text ("Imported"/
    // "Verified") is not there to be walked yet (the same reason
    // `AgentPanel`'s `Bounded` note gives for `Markdown`). Asserting on the
    // PROP the card passed is what actually proves the card decided
    // correctly; `TrustBadge`'s own rendering is proved in
    // `tests/trust-badge-component.test.ts`.
    it("shows Imported for an unverified item with no verification on file", () => {
      const card = ItemCard({
        entry: entry("backlog", {}, { unverifiedOrigin: true, verification: null }),
        needsYou: false,
        now: 0,
      });
      const badge = findOneByType(card, TrustBadge);
      expect((badge.props as { verified: boolean }).verified).toBe(false);
    });

    it("shows Verified once a historical_verification is on file", () => {
      const card = ItemCard({
        entry: entry(
          "backlog",
          {},
          {
            unverifiedOrigin: true,
            verification: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              checkedByType: "agent",
              checkedById: "crew-1",
              body: "Checked.",
              commitSha: "abc123",
            },
          },
        ),
        needsYou: false,
        now: 0,
      });
      const badge = findOneByType(card, TrustBadge);
      expect((badge.props as { verified: boolean }).verified).toBe(true);
    });

    // Fails if the dashed-border class is applied unconditionally, or never.
    it("marks the card itself unverified only when trust says so", () => {
      const unverified = ItemCard({
        entry: entry("backlog", {}, { unverifiedOrigin: true, verification: null }),
        needsYou: false,
        now: 0,
      });
      expect((unverified.props as { "data-unverified"?: boolean })["data-unverified"]).toBe(true);

      const verified = ItemCard({
        entry: entry(
          "backlog",
          {},
          {
            unverifiedOrigin: false,
            verification: null,
          },
        ),
        needsYou: false,
        now: 0,
      });
      expect(
        (verified.props as { "data-unverified"?: boolean })["data-unverified"],
      ).toBeUndefined();
    });
  });

  describe("presence — M10 T16", () => {
    it("shows nothing when nobody holds the card", () => {
      const card = ItemCard({ entry: entry("backlog"), needsYou: false, now: 0 });
      expect(findAllByType(card, AgentPresenceDot)).toHaveLength(0);
    });

    it("shows the holder's name and a presence dot for a live claim", () => {
      const held: BoardEntry = {
        ...entry("in_progress"),
        assignments: [assignment({ displayName: "Gary", liveness: "running" })],
      };
      const card = ItemCard({ entry: held, needsYou: false, now: 0 });
      expect(textOf(card)).toContain("Gary");
      const dots = findAllByType(card, AgentPresenceDot);
      expect(dots).toHaveLength(1);
      expect((dots[0]!.props as { liveness: string }).liveness).toBe("running");
    });

    it("renders one row per assignment when more than one holder is on it", () => {
      // SCHEMA.md §2: an item can be held by an orchestrator plus a builder
      // at once. A card that showed only one holder would silently drop a
      // fact a reader would otherwise have no way to see.
      const held: BoardEntry = {
        ...entry("in_progress"),
        assignments: [
          assignment({ holderId: "gary", displayName: "Gary", role: "builder" }),
          assignment({ holderId: "priya", displayName: "Priya", role: "orchestrator" }),
        ],
      };
      const card = ItemCard({ entry: held, needsYou: false, now: 0 });
      expect(findAllByType(card, AgentPresenceDot)).toHaveLength(2);
      const text = textOf(card);
      expect(text).toContain("Gary");
      expect(text).toContain("Priya");
    });

    it("renders all four liveness values distinguishably, none folded into another", () => {
      const values = ["running", "stalled", "dead", "superseded"] as const;
      const held: BoardEntry = {
        ...entry("in_progress"),
        assignments: values.map((liveness, i) =>
          assignment({ holderId: `h-${i}`, displayName: `Agent ${i}`, liveness }),
        ),
      };
      const card = ItemCard({ entry: held, needsYou: false, now: 0 });
      const dots = findAllByType(card, AgentPresenceDot);
      expect(dots.map((d) => (d.props as { liveness: string }).liveness)).toEqual([
        "running",
        "stalled",
        "dead",
        "superseded",
      ]);
    });

    it("shows how long since the holder last reported", () => {
      const held: BoardEntry = {
        ...entry("in_progress"),
        assignments: [assignment({ lastActive: "2026-01-01T00:00:00.000Z" })],
      };
      const now = Date.parse("2026-01-01T02:00:00.000Z");
      const card = ItemCard({ entry: held, needsYou: false, now });
      expect(textOf(card)).toContain("2h ago");
    });
  });
});
