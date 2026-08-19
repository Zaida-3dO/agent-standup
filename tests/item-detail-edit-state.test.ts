// Inline edit on the item detail page — M10 T10. The fetch shaping and the
// success/failure branching, with a stub `fetch`, no DOM and no server.
// Same shape as `tests/admin-state.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { fieldForEdit, submitItemEdit, titleDraftIsValid } from "@/lib/item-detail/edit-state";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fieldForEdit", () => {
  it("maps title to a title field", () => {
    expect(fieldForEdit("title", "New title")).toEqual({ title: "New title" });
  });

  it("maps a blank headline draft to null, clearing it", () => {
    // update_item's own schema takes `headline` as nullable — clearing it
    // back to "nobody has written one" is a real, distinct state (see
    // update-item.ts's own header), not an error.
    expect(fieldForEdit("headline", "")).toEqual({ headline: null });
    expect(fieldForEdit("headline", "   ")).toEqual({ headline: null });
  });

  it("keeps a non-blank headline draft as text", () => {
    expect(fieldForEdit("headline", "Ships the thing")).toEqual({ headline: "Ships the thing" });
  });

  it("maps priority and area to their own fields", () => {
    expect(fieldForEdit("priority", "P0")).toEqual({ priority: "P0" });
    expect(fieldForEdit("area", "web")).toEqual({ area: "web" });
  });
});

describe("titleDraftIsValid", () => {
  it("rejects an empty or whitespace-only draft", () => {
    expect(titleDraftIsValid("")).toBe(false);
    expect(titleDraftIsValid("   ")).toBe(false);
  });

  it("accepts anything with real content", () => {
    expect(titleDraftIsValid("A title")).toBe(true);
  });
});

describe("submitItemEdit", () => {
  it("PATCHes the item's own path with only the named fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ item: { id: "item-1", title: "New" } }));
    const outcome = await submitItemEdit(
      "item-1",
      { title: "New" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ui/items/item-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ title: "New" });
  });

  it("escapes an id that would otherwise change the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ item: {} }));
    await submitItemEdit("a/b", { title: "x" }, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/ui/items/a%2Fb");
  });

  it("returns the updated item on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ item: { id: "item-1", title: "Renamed" } }));
    const outcome = await submitItemEdit(
      "item-1",
      { title: "Renamed" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item).toEqual({ id: "item-1", title: "Renamed" });
  });

  it("surfaces the service's own refusal message", async () => {
    // update_item refuses a blank title by naming the field; that sentence
    // is what belongs beside the input, not the status code.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "title must not be empty" } }, { status: 400 }),
    );
    const outcome = await submitItemEdit(
      "item-1",
      { title: "" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("title must not be empty");
  });

  it("falls back to the status when the body carries no error envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 502 }));
    const outcome = await submitItemEdit(
      "item-1",
      { title: "x" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("502");
  });
});
