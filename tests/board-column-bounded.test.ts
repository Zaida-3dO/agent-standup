// The bounded, paged column — the "show more" control, the true count in the
// heading, and which of the shared states a column reaches for.
//
// Hook-free and prop-driven, so `BoardColumn` is called directly and its
// element tree inspected (`tests/helpers/react-element.ts`).
//
// **What would make this file hollow.** Asserting that a column with a cursor
// renders a button proves very little on its own — so the assertions here are
// about the cases that differ: that the control appears on a cursor and NOT
// on its absence, that pressing it names its own column, that the heading
// shows the server's total rather than the page length, and that a withheld
// column reaches a different shared state from an empty one.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { BoardColumn } from "@/components/board/BoardColumn";
import { ItemCard } from "@/components/board/ItemCard";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import type { BoardColumnId, BoardEntry, BoardSection } from "@/lib/board/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

function entry(id: string, column: BoardColumnId = "backlog"): BoardEntry {
  return {
    item: {
      id,
      title: `Item ${id}`,
      headline: null,
      kind: "task",
      state: "on_deck",
      priority: "P2",
      area: "web",
      repo: null,
      blockedOnPersonId: null,
      blockedOnType: null,
      blockedReason: null,
      pauseReason: null,
    },
    column,
    assignments: [],
  };
}

function section(ids: readonly string[], overrides: Partial<BoardSection> = {}): BoardSection {
  return {
    entries: ids.map((id) => entry(id)),
    total: ids.length,
    nextCursor: null,
    withheld: false,
    ...overrides,
  };
}

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

function buttonsOf(root: ReactNode) {
  return [...walk(root)].filter((el) => el.type === "button");
}

describe("the column's show-more control", () => {
  it("appears when the column has a cursor and the caller can page", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: () => {},
    });
    expect(buttonsOf(element).length).toBe(1);
  });

  it("does not appear on a fully-loaded column", () => {
    // The distinguishing case: same entries, same total, no cursor. A
    // control offered here promises rows that do not exist.
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: null }),
      personId: null,
      onShowMore: () => {},
    });
    expect(buttonsOf(element).length).toBe(0);
  });

  it("does not appear when the caller wired no paging, even with a cursor", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
    });
    expect(buttonsOf(element).length).toBe(0);
  });

  it("asks for its own column when pressed", () => {
    // A column that passed the wrong id would page a different column —
    // silently, since both would then render more cards.
    const asked: string[] = [];
    const element = BoardColumn({
      column: "completed",
      section: section(["a"], { total: 222, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: (column) => asked.push(column),
    });
    (buttonsOf(element)[0]!.props as { onClick: () => void }).onClick();
    expect(asked).toEqual(["completed"]);
  });

  it("disables the control while a page is already in flight", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: () => {},
      loadingMore: true,
    });
    expect((buttonsOf(element)[0]!.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("says how far through the column the reader is, from the page and the true total", () => {
    // "Show more" alone does not say more of how many. Both numbers must be
    // present, and the second is the server's total, not the page length.
    const element = BoardColumn({
      column: "backlog",
      section: section(["a", "b"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: () => {},
    });
    const text = textOf(element);
    expect(text).toContain("2");
    expect(text).toContain("146");
  });
});

describe("the column's scroll region", () => {
  it("is reachable from the keyboard, and says what it is", () => {
    // Bounding the column is what makes this necessary. The page used to
    // scroll, and page scroll is keyboard-reachable for free; a bounded
    // column's own scroll region is not, so without a tab stop a
    // keyboard-only reader reaches the first screenful of a 146-item column
    // and nothing past it.
    const element = BoardColumn({
      column: "backlog",
      section: section(["a", "b"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
    });
    const focusable = [...walk(element)].filter(
      (el) => (el.props as { tabIndex?: number }).tabIndex === 0,
    );
    expect(focusable.length).toBe(1);
    // A focusable element with no accessible name is announced as nothing,
    // which trades one barrier for another.
    const label = (focusable[0]!.props as { "aria-label"?: string })["aria-label"];
    expect(label).toContain("Backlog");
  });
});

describe("the column's heading count", () => {
  it("is the server's total, never the number of cards rendered", () => {
    // #123 in its original form. The page holds one card; the column holds
    // 146. A heading reading "1" is the bug.
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
    });
    expect(textOf(element)).toContain("146");
    expect(findAllByType(element, ItemCard).length).toBe(1);
  });

  it("reports a withheld column's real size even though it rendered no cards", () => {
    // The case that produced #123: 222 completed items, nothing fetched.
    const element = BoardColumn({
      column: "completed",
      section: { entries: [], total: 222, nextCursor: null, withheld: true },
      personId: null,
    });
    expect(textOf(element)).toContain("222");
  });
});

describe("which state the column shows when it has no cards", () => {
  it("reaches for the shared empty state when the column is genuinely empty", () => {
    const element = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
    });
    expect((findOneByType(element, EmptyState).props as { kind: string }).kind).toBe("empty");
  });

  it("reaches for a DIFFERENT state when the column was withheld", () => {
    // The two sections differ only in `withheld` and `total`; if these
    // rendered the same, a reader would be told there is no finished work
    // while the store holds 222 finished items.
    const element = BoardColumn({
      column: "completed",
      section: { entries: [], total: 222, nextCursor: null, withheld: true },
      personId: null,
    });
    expect((findOneByType(element, EmptyState).props as { kind: string }).kind).toBe("withheld");
  });

  it("reaches for the filtered state when a filter excluded everything", () => {
    const element = BoardColumn({
      column: "backlog",
      section: { entries: [], total: 146, nextCursor: null, withheld: false },
      personId: null,
      filtered: true,
    });
    expect((findOneByType(element, EmptyState).props as { kind: string }).kind).toBe("filtered");
  });

  it("offers to load a withheld column through the same paging handler", () => {
    // A withheld column has no cursor, so it is reached by asking for its
    // first page — the control exists precisely because the empty state
    // would otherwise be a dead end.
    const asked: string[] = [];
    const element = BoardColumn({
      column: "completed",
      section: { entries: [], total: 222, nextCursor: null, withheld: true },
      personId: null,
      onShowMore: (column) => asked.push(column),
    });
    const load = findOneByType(element, EmptyState).props as { onLoad?: () => void };
    load.onLoad?.();
    expect(asked).toEqual(["completed"]);
  });

  it("shows no empty state at all while the first page is loading", () => {
    // A column rendering "nothing here" during its own first load reports a
    // fact it does not yet know — the same confusion as the states above.
    const element = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      loading: true,
    });
    expect(findAllByType(element, EmptyState).length).toBe(0);
    expect(findAllByType(element, LoadingState).length).toBe(1);
  });
});

describe("a failed page request", () => {
  it("names the failed call and keeps the cards already shown", () => {
    // A page failure is not a board failure: the reader is looking at
    // cards, those cards loaded fine, and so they stay.
    const element = BoardColumn({
      column: "backlog",
      section: section(["a", "b"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: () => {},
      pageError: "Could not load the board (GET /api/board returned 500).",
    });
    const error = findOneByType(element, ErrorState);
    expect((error.props as { message: string }).message).toContain("GET /api/board");
    expect(findAllByType(element, ItemCard).length).toBe(2);
  });

  it("shows no error block when the column's last page succeeded", () => {
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: () => {},
      pageError: null,
    });
    expect(findAllByType(element, ErrorState).length).toBe(0);
  });

  it("retries through the same paging handler", () => {
    const asked: string[] = [];
    const element = BoardColumn({
      column: "backlog",
      section: section(["a"], { total: 146, nextCursor: "cur-1" }),
      personId: null,
      onShowMore: (column) => asked.push(column),
      pageError: "Could not load the board (GET /api/board returned 500).",
    });
    const error = findOneByType(element, ErrorState).props as { onRetry?: () => void };
    error.onRetry?.();
    expect(asked).toEqual(["backlog"]);
  });
});
