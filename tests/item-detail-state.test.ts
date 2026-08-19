// The item-detail view's load lifecycle — MILESTONES.md #72. The fetch
// shaping and the error messages, with a stub `fetch`, no DOM and no
// server. Same shape as `tests/board-state.test.ts`.
import { describe, expect, it } from "vitest";
import { detailErrorMessageFrom, fetchItemDetail } from "@/lib/item-detail/state";
import type { ItemDetail } from "@/lib/item-detail/types";

function detailItem(): ItemDetail["item"] {
  return {
    id: "item-1",
    parentId: null,
    title: "An item",
    headline: null,
    body: "",
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    branch: null,
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
}

/** A `fetch` that answers once with the given status and body, recording the URL it was called with. */
function stubFetch(status: number, body: unknown): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

describe("fetchItemDetail", () => {
  it("requests the detail endpoint for the given id", async () => {
    const impl = stubFetch(200, { detail: { item: detailItem() } });
    await fetchItemDetail("item-1", impl);
    expect(impl.calls).toEqual(["/api/ui/items/item-1/detail"]);
  });

  it("percent-encodes an id so a slash in it cannot reach a different route", async () => {
    // Without encoding, an id containing a slash would address some other
    // path entirely — the request would succeed against the wrong resource
    // rather than fail, which is the worst shape of this bug.
    const impl = stubFetch(200, { detail: { item: detailItem() } });
    await fetchItemDetail("a/b", impl);
    expect(impl.calls).toEqual(["/api/ui/items/a%2Fb/detail"]);
  });

  it("fills in every missing collection so a partial response renders empty, not blank", async () => {
    const detail = await fetchItemDetail(
      "item-1",
      stubFetch(200, { detail: { item: detailItem() } }),
    );
    expect(detail.subtasks).toEqual([]);
    expect(detail.artifacts).toEqual([]);
    expect(detail.history).toEqual([]);
    expect(detail.historyTruncated).toBe(false);
    expect(detail.summary).toBeNull();
    expect(detail.column).toBe("backlog");
  });

  it("keeps what the response did carry", async () => {
    const detail = await fetchItemDetail(
      "item-1",
      stubFetch(200, {
        detail: {
          item: detailItem(),
          column: "in_progress",
          subtasks: [{ id: "s1" }],
          historyTruncated: true,
        },
      }),
    );
    expect(detail.column).toBe("in_progress");
    expect(detail.subtasks).toHaveLength(1);
    expect(detail.historyTruncated).toBe(true);
  });

  it("gives a 404 its own message naming the item, not a bare status", async () => {
    await expect(fetchItemDetail("missing", stubFetch(404, {}))).rejects.toThrow(
      "No such item: missing.",
    );
  });

  it("reports the status for any other failure", async () => {
    await expect(fetchItemDetail("item-1", stubFetch(500, {}))).rejects.toThrow("500");
  });

  it("refuses a 200 that carried no item rather than rendering an undefined header", async () => {
    await expect(fetchItemDetail("item-1", stubFetch(200, { detail: {} }))).rejects.toThrow(
      "carried no item",
    );
  });
});

describe("detailErrorMessageFrom", () => {
  it("uses an Error's own message", () => {
    expect(detailErrorMessageFrom(new Error("boom"))).toBe("boom");
  });

  it("falls back for a thrown non-Error, rather than showing [object Object]", () => {
    expect(detailErrorMessageFrom({ weird: true })).toBe("Could not load this item.");
    expect(detailErrorMessageFrom("a string")).toBe("Could not load this item.");
  });
});
