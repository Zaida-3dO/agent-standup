// src/lib/board/state.ts — the board's load lifecycle for MILESTONES.md
// #37: what `GET /api/board` turns into, and what a failure turns into.
import { describe, expect, it } from "vitest";
import { boardErrorMessageFrom, fetchBoard, fetchBoardColumn } from "@/lib/board/state";
import { BOARD_COLUMNS } from "@/lib/board/view";

/** A minimal stand-in for `fetch` — no network, no DOM. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchBoardColumn", () => {
  it("returns the section the API sent, count and cursor included", async () => {
    const section = await fetchBoardColumn("waiting", {
      fetchImpl: fetchReturning(200, {
        board: {
          columns: {
            waiting: {
              entries: [{ item: { id: "a", title: "T", state: "paused" }, column: "waiting" }],
              total: 12,
              nextCursor: "a",
              withheld: false,
            },
          },
        },
      }),
    });
    expect(section.entries).toHaveLength(1);
    expect(section.entries[0]!.item.id).toBe("a");
    // The count is the server's, not the page length — #123. A client that
    // recomputed it from `entries` would report 1 here.
    expect(section.total).toBe(12);
    expect(section.nextCursor).toBe("a");
  });

  it("asks for the named column, so a section is fetched rather than the whole board", async () => {
    let requested: string | undefined;
    const spy = (async (url: string) => {
      requested = url;
      return { ok: true, status: 200, json: async () => ({ board: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBoardColumn("completed", { fetchImpl: spy });
    expect(requested).toBe("/api/board?column=completed");
  });

  it("passes a cursor through when paging further", async () => {
    let requested: string | undefined;
    const spy = (async (url: string) => {
      requested = url;
      return { ok: true, status: 200, json: async () => ({ board: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBoardColumn("backlog", { cursor: "item-9", fetchImpl: spy });
    expect(requested).toContain("column=backlog");
    expect(requested).toContain("cursor=item-9");
  });

  it("fills in a section the response omitted, so a component never indexes undefined", async () => {
    const section = await fetchBoardColumn("backlog", {
      fetchImpl: fetchReturning(200, { board: { columns: {} } }),
    });
    expect(section.entries).toEqual([]);
    expect(section.total).toBe(0);
  });
});

describe("fetchBoard", () => {
  it("requests every column, because the board view shows all four", async () => {
    const requested: string[] = [];
    const spy = (async (url: string) => {
      requested.push(url);
      return { ok: true, status: 200, json: async () => ({ board: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBoard(spy);
    // Explicitly including the two a default read withholds — the view's
    // whole job is to show them (#109 part 2 applies to agent reads, not to
    // the board UI).
    for (const column of BOARD_COLUMNS) {
      expect(requested.some((url) => url.includes(`column=${column}`))).toBe(true);
    }
  });

  it("tolerates a response with no board key at all", async () => {
    const board = await fetchBoard(fetchReturning(200, {}));
    for (const column of BOARD_COLUMNS) {
      expect(board[column].entries).toEqual([]);
    }
  });

  it("throws a showable message, naming the status, when the request fails", async () => {
    await expect(fetchBoard(fetchReturning(500, {}))).rejects.toThrow(/500/);
    await expect(fetchBoard(fetchReturning(500, {}))).rejects.toThrow(/Could not load the board/);
  });

  it("reports the actual status code, not a fixed one", async () => {
    await expect(fetchBoard(fetchReturning(404, {}))).rejects.toThrow(/404/);
  });

  it("does not parse the body of a failed response", async () => {
    // A 500 typically has an HTML body; parsing it would throw a
    // JSON-parse error instead of the message the user should see.
    const failing = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchBoard(failing)).rejects.toThrow(/503/);
  });
});

describe("boardErrorMessageFrom", () => {
  it("uses an Error's own message", () => {
    expect(boardErrorMessageFrom(new Error("network down"))).toBe("network down");
  });

  it("falls back to a showable message for a non-Error, never a raw object", () => {
    expect(boardErrorMessageFrom({ weird: true })).toBe("Could not load the board.");
    expect(boardErrorMessageFrom("a string")).toBe("Could not load the board.");
    expect(boardErrorMessageFrom(undefined)).toBe("Could not load the board.");
  });
});
