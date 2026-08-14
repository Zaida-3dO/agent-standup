// src/lib/board/state.ts — the board's load lifecycle for MILESTONES.md
// #37: what `GET /api/board` turns into, and what a failure turns into.
import { describe, expect, it } from "vitest";
import { boardErrorMessageFrom, fetchBoard } from "@/lib/board/state";
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

describe("fetchBoard", () => {
  it("returns the board the API sent", async () => {
    const board = await fetchBoard(
      fetchReturning(200, {
        board: {
          backlog: [],
          in_progress: [],
          waiting: [{ item: { id: "a", title: "T", state: "paused" }, column: "waiting" }],
          completed: [],
        },
      }),
    );
    expect(board.waiting).toHaveLength(1);
    expect(board.waiting[0]!.item.id).toBe("a");
  });

  it("requests the board endpoint", async () => {
    let requested: string | undefined;
    const spy = (async (url: string) => {
      requested = url;
      return { ok: true, status: 200, json: async () => ({ board: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBoard(spy);
    expect(requested).toBe("/api/board");
  });

  it("fills in any column the response omitted, so a component never indexes undefined", async () => {
    const board = await fetchBoard(fetchReturning(200, { board: { backlog: [] } }));
    for (const column of BOARD_COLUMNS) {
      expect(Array.isArray(board[column])).toBe(true);
    }
  });

  it("tolerates a response with no board key at all", async () => {
    const board = await fetchBoard(fetchReturning(200, {}));
    for (const column of BOARD_COLUMNS) {
      expect(board[column]).toEqual([]);
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
