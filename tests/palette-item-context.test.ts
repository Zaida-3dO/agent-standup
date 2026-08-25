// What item the palette acts on, and where its state comes from —
// `@/lib/palette/item-context`.
//
// The whole reason this module fetches rather than reading the page is that
// `expectedFrom` must be TRUE. A precondition built from what the UI last
// rendered would agree with itself and pass even when the item had moved,
// which turns the safety check into a rubber stamp.
import { describe, expect, it } from "vitest";
import { fetchPaletteItem, itemIdFromPath } from "@/lib/palette/item-context";

describe("itemIdFromPath", () => {
  it("reads the id off an item page", () => {
    expect(itemIdFromPath("/items/abc-123")).toBe("abc-123");
  });

  it("reads the id off a sub-path of an item page", () => {
    expect(itemIdFromPath("/items/abc-123/history")).toBe("abc-123");
  });

  it("returns null for a path with no id", () => {
    // `/items/` with an empty id would otherwise be requested as
    // `/api/items/`, which is a different endpoint entirely.
    expect(itemIdFromPath("/items")).toBeNull();
    expect(itemIdFromPath("/items/")).toBeNull();
  });

  it("returns null for every other page", () => {
    for (const path of ["/", "/board", "/projects/abc", "/itemsish/abc"]) {
      expect(itemIdFromPath(path), `${path} should not look like an item page`).toBeNull();
    }
  });

  it("returns null for an unresolved path", () => {
    expect(itemIdFromPath(undefined)).toBeNull();
  });
});

/** A `fetch` stub answering with one JSON body. */
function respondWith(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchPaletteItem", () => {
  it("returns the server's id, title and state", () => {
    return fetchPaletteItem(
      "abc",
      respondWith({ item: { id: "abc", title: "Wire the thing", state: "executing" } }),
    ).then((item) => {
      expect(item).toEqual({ id: "abc", title: "Wire the thing", state: "executing" });
    });
  });

  it("requests the item through the UI proxy, not the API directly", async () => {
    // A browser holds no credential, so a bare `/api/` call is refused.
    let requested: string | null = null;
    const spy = (async (input: string) => {
      requested = input;
      return {
        ok: true,
        status: 200,
        json: async () => ({ item: { id: "abc", title: "T", state: "executing" } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchPaletteItem("abc", spy);
    expect(requested).toBe("/api/ui/items/abc");
  });

  it("encodes an id that would otherwise change the path", async () => {
    let requested: string | null = null;
    const spy = (async (input: string) => {
      requested = input;
      return { ok: true, status: 200, json: async () => ({ item: null }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchPaletteItem("a/b", spy);
    expect(requested).toBe("/api/ui/items/a%2Fb");
  });

  it("returns null on a failed response", async () => {
    expect(await fetchPaletteItem("abc", respondWith({}, false, 404))).toBeNull();
  });

  it("returns null when the response carries no item", async () => {
    expect(await fetchPaletteItem("abc", respondWith({}))).toBeNull();
  });

  it("returns null when the row has no state, rather than context with a hole", async () => {
    // A row with no state cannot supply an `expectedFrom`, which is the
    // only reason this fetch exists. Returning it would leave the palette
    // offering state verbs it cannot safely perform.
    expect(
      await fetchPaletteItem("abc", respondWith({ item: { id: "abc", title: "T" } })),
    ).toBeNull();
    expect(
      await fetchPaletteItem("abc", respondWith({ item: { id: "abc", title: "T", state: "" } })),
    ).toBeNull();
  });

  it("falls back to the id when the row has no title", async () => {
    // A missing title is cosmetic — the state is what matters — so this
    // degrades rather than refusing.
    const item = await fetchPaletteItem(
      "abc",
      respondWith({ item: { id: "abc", state: "paused" } }),
    );
    expect(item).toEqual({ id: "abc", title: "abc", state: "paused" });
  });

  it("returns null rather than throwing when the request fails outright", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    // A palette that failed to OPEN because a decoration could not load
    // would be worse than one that opens without the state verbs.
    expect(await fetchPaletteItem("abc", throwing)).toBeNull();
  });

  it("returns null rather than throwing when the body is not JSON", async () => {
    const badBody = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchPaletteItem("abc", badBody)).toBeNull();
  });
});
