// Appending a page to a column — `@/lib/board/paging`, the consumer for the
// `nextCursor`/`total`/`withheld` the board read has returned since #109.
//
// **What would make this file hollow.** Asserting that a merged column
// "contains" the new page's entries proves nothing: an implementation that
// swapped the column for the new page contains them too, and so does one
// that concatenates blindly. The load-bearing assertions are therefore about
// what survives and what does not — that the earlier page is still there
// afterwards (a swap fails), that the cursor advances to the new page's (a
// stale cursor fails), and that an entry seen twice is rendered once (blind
// concatenation fails).
import { describe, expect, it } from "vitest";
import { appendPage, boardWithPage, hasMore } from "@/lib/board/paging";
import { emptyBoard } from "@/lib/board/view";
import type { BoardEntry, BoardSection } from "@/lib/board/types";

function entry(id: string): BoardEntry {
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
    column: "backlog",
    assignments: [],
  };
}

function section(ids: readonly string[], overrides: Partial<BoardSection> = {}): BoardSection {
  return {
    entries: ids.map(entry),
    total: ids.length,
    nextCursor: null,
    withheld: false,
    ...overrides,
  };
}

const idsOf = (s: BoardSection) => s.entries.map((e) => e.item.id);

describe("appendPage", () => {
  it("keeps what was already shown and adds the new page after it", () => {
    // Replacement would pass a "contains the new entries" check and is the
    // failure this asserts against: pressing "show more" would swap the
    // page rather than extend it, and the rows already read would vanish.
    const merged = appendPage(
      section(["a", "b"], { nextCursor: "cur-1", total: 5 }),
      section(["c", "d"]),
    );
    expect(idsOf(merged)).toEqual(["a", "b", "c", "d"]);
  });

  it("advances the cursor to the new page's, so the next press fetches the next page", () => {
    // A stale cursor re-requests the page just shown, forever — a control
    // that appears to do nothing from the second press onwards.
    const merged = appendPage(
      section(["a"], { nextCursor: "cur-1" }),
      section(["b"], { nextCursor: "cur-2" }),
    );
    expect(merged.nextCursor).toBe("cur-2");
  });

  it("takes the total from the new page rather than counting what it now holds", () => {
    // The count is the server's, never the length — #123 at the merge step,
    // where the two are close enough to look right and still be wrong.
    const merged = appendPage(
      section(["a", "b"], { total: 146, nextCursor: "cur-1" }),
      section(["c"], { total: 146 }),
    );
    expect(merged.entries.length).toBe(3);
    expect(merged.total).toBe(146);
  });

  it("clears the withheld flag once the column has actually been read", () => {
    // Loading a withheld column is how a reader gets it back; if the flag
    // survived, the column would keep claiming it was never fetched.
    const merged = appendPage(
      section([], { total: 40, withheld: true }),
      section(["a", "b"], { total: 40 }),
    );
    expect(merged.withheld).toBe(false);
    expect(idsOf(merged)).toEqual(["a", "b"]);
  });

  it("never renders an entry twice when a page overlaps what is shown", () => {
    // Keyset pages do not normally overlap, so this is about the abnormal
    // cases that are nevertheless real: a double-fired control, or an item
    // created above the cursor between two reads. Two identical React keys
    // is a defect that outlives whatever caused it.
    const merged = appendPage(section(["a", "b"]), section(["b", "c"]));
    expect(idsOf(merged)).toEqual(["a", "b", "c"]);
  });
});

describe("boardWithPage", () => {
  it("extends only the named column and leaves the other three identical", () => {
    // Columns page independently — paging Backlog must not disturb Completed.
    const board = { ...emptyBoard(), backlog: section(["a"], { nextCursor: "cur-1" }) };
    const next = boardWithPage(board, "backlog", section(["b"]));
    expect(idsOf(next.backlog)).toEqual(["a", "b"]);
    expect(next.in_progress).toBe(board.in_progress);
    expect(next.waiting).toBe(board.waiting);
    expect(next.completed).toBe(board.completed);
  });
});

describe("hasMore", () => {
  it("reads the cursor, not the page length against the total", () => {
    // A board page carries the column's PROJECTS unpaged alongside its
    // paged tasks, so a first page of a 146-item backlog can return 41 rows
    // against a 25-row limit. `entries.length < total` would then keep
    // offering "show more" after the last page, and the press returns
    // nothing. Verified against the real corpus — see the task's brief.
    expect(hasMore(section(["a"], { total: 146, nextCursor: "cur-1" }))).toBe(true);
    // Everything fetched, but the length still differs from the total: only
    // the cursor can tell this case from the one above.
    expect(hasMore(section(["a"], { total: 146, nextCursor: null }))).toBe(false);
  });
});
