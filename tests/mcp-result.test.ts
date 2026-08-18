// How a service answer is rendered as a tool result (MILESTONES.md #30).
//
// `tests/mcp-server.test.ts` and `tests/mcp-http.test.ts` drive this through
// the protocol, which covers the shape a registered operation returns — a
// plain object. This file covers the shapes they cannot reach through the
// protocol, because no registered operation returns one: an array, a
// scalar, `null`, `undefined`.
//
// Those are worth testing rather than deferring, because `structuredContent`
// is not permitted to be an array or a scalar by the protocol, so an
// operation that starts returning a list would produce a result a strict
// client rejects — and it would do so at the point the operation lands,
// not at the point this adapter changed. Added after mutation testing
// showed the branches handling them survived every mutation: the rendering
// logic existed and nothing was checking it.
import { describe, expect, it } from "vitest";
import { GuardRejectedError, NotFoundError } from "@/lib/service";
import { toolRejection, toolSuccess } from "@/lib/mcp";

describe("rendering a successful answer", () => {
  it("passes a plain object through as the structured content itself", () => {
    const value = { id: "item-1", state: "ready" };
    const result = toolSuccess(value);
    expect(result.structuredContent).toEqual(value);
    expect(result.isError).toBeUndefined();
  });

  it("wraps an array, which the protocol will not accept as structured content", () => {
    // `structuredContent` must be an object. An array passed through
    // unchanged would be a malformed result the moment an operation
    // returned a list.
    const result = toolSuccess([1, 2, 3]);
    expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
    expect(Array.isArray(result.structuredContent)).toBe(false);
  });

  it("wraps a scalar", () => {
    expect(toolSuccess(42).structuredContent).toEqual({ result: 42 });
    expect(toolSuccess("done").structuredContent).toEqual({ result: "done" });
  });

  it("renders null as an answer, not as an absence", () => {
    const result = toolSuccess(null);
    expect(result.structuredContent).toEqual({ result: null });
    expect(result.content[0]?.text).toBe("null");
  });

  it("renders undefined as text a client can parse", () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string — a content
    // block whose `text` is missing is a protocol error rather than an
    // empty answer, so this path has to substitute something.
    const result = toolSuccess(undefined);
    expect(result.content[0]?.text).toBe("null");
    expect(typeof result.content[0]?.text).toBe("string");
    expect(result.structuredContent).toEqual({ result: null });
  });

  it("puts the readable JSON in the text block for a client that reads only content", () => {
    const result = toolSuccess({ nested: { deep: true } });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ nested: { deep: true } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });

  // `checkpoint` and `note` return `AppendedEvent` (src/lib/events.ts) with
  // real `bigint` `id`/`txId` — see `bigintSafe`'s own comment in
  // src/lib/mcp/result.ts. Without it these two cases throw inside
  // `toolSuccess` itself (`JSON.stringify` refuses a raw bigint outright),
  // which `mcp-session-tools.test.ts` proves end to end through a real
  // `checkpoint` call; these are the isolated unit cases for the renderer.
  it("stringifies a top-level bigint field rather than throwing", () => {
    const result = toolSuccess({ id: 42n, txId: 7n });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: "42", txId: "7" });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ id: "42", txId: "7" });
  });

  it("preserves full precision — a value JS `number` cannot represent exactly", () => {
    // Mutation evidence: a mutant that swapped `.toString()` for `Number(x)`
    // (or dropped the bigint branch to fall through to a numeric coercion)
    // would round this to `9007199254740992` — one off from the real value —
    // which only a value past `Number.MAX_SAFE_INTEGER` can expose.
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2, odd — unrepresentable as a number
    const result = toolSuccess({ id: huge });
    expect(result.structuredContent).toEqual({ id: "9007199254740993" });
    expect(result.content[0]?.text).toContain("9007199254740993");
  });

  it("stringifies a bigint nested inside an object", () => {
    const result = toolSuccess({ event: { id: 5n, body: "note" } });
    expect(result.structuredContent).toEqual({ event: { id: "5", body: "note" } });
  });

  it("stringifies a bigint nested inside an array", () => {
    const result = toolSuccess({ events: [{ id: 1n }, { id: 2n }] });
    expect(result.structuredContent).toEqual({ events: [{ id: "1" }, { id: "2" }] });
  });

  it("passes a Date through untouched rather than flattening it to an empty object", () => {
    // Mutation evidence: dropping the `instanceof Date` branch would send a
    // Date into the plain-object walk, where `Object.entries` finds no own
    // enumerable properties — the field would render as `{}` instead of the
    // timestamp, which this test's exact-string assertion catches.
    const ts = new Date("2026-01-01T00:00:00.000Z");
    const result = toolSuccess({ ts });
    expect((result.structuredContent as { ts: Date }).ts).toBe(ts);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ ts: "2026-01-01T00:00:00.000Z" });
  });

  it("leaves a null field null rather than crashing while walking it", () => {
    // Mutation evidence: dropping the `value !== null` guard on the
    // object-walk branch would call `Object.entries(null)`, which throws —
    // a shape every write operation here actually returns
    // (`assignmentId: null` is normal, not exceptional).
    const result = toolSuccess({ assignmentId: null, count: 3n });
    expect(result.structuredContent).toEqual({ assignmentId: null, count: "3" });
  });
});

// The text block is serialised compactly (MILESTONES.md #110). Every
// assertion here fails if `JSON.stringify(value, null, 2)` comes back:
// each names a character sequence only an indented rendering produces.
describe("serialising the text block compactly", () => {
  it("emits no indentation for a nested object", () => {
    const text = toolSuccess({ nested: { deep: true } }).content[0]?.text ?? "";
    expect(text).toBe('{"nested":{"deep":true}}');
    expect(text).not.toContain("\n");
    expect(text).not.toContain("  ");
  });

  it("emits no indentation for an array-valued field", () => {
    // Arrays are where the pretty renderer is most expensive — one line
    // and one indent per element — so a board answer is mostly this shape.
    const text = toolSuccess({ items: [{ id: 1 }, { id: 2 }] }).content[0]?.text ?? "";
    expect(text).toBe('{"items":[{"id":1},{"id":2}]}');
    expect(text).not.toMatch(/\n\s+/);
  });

  it("renders a refusal compactly too, so one format covers every result", () => {
    const rejection = toolRejection(new NotFoundError("No such item.", { fields: ["itemId"] }));
    const text = rejection.content[0]?.text ?? "";
    // Exact, not a shape check: an indented rendering of this same value
    // differs from it only in whitespace, so anything looser passes
    // against both formats and proves nothing about which one was used.
    expect(text).toBe('{"code":"not_found","fields":["itemId"],"message":"No such item."}');
    expect(JSON.parse(text)).toMatchObject({ code: "not_found", fields: ["itemId"] });
  });

  it("is materially smaller than the indented rendering on a realistic payload", () => {
    // The row exists because of a measurement, so the test carries one:
    // a board-shaped answer, compared against what the indented renderer
    // would have produced for the identical value.
    const value = {
      items: Array.from({ length: 200 }, (_, i) => ({
        id: "itm_" + i,
        title: "a task title of ordinary length",
        state: "executing",
        assigneeId: i % 2 ? "person_" + i : null,
        labels: ["mcp", "payload"],
      })),
    };
    const compact = toolSuccess(value).content[0]?.text ?? "";
    const indented = JSON.stringify(value, null, 2);
    expect(compact.length).toBeLessThan(indented.length * 0.7);
    expect(JSON.parse(compact)).toEqual(value);
  });

  it("still parses back to exactly the value, so no client loses data to the saving", () => {
    // The compatibility claim in one assertion: a client that reads only
    // `text` recovers the same object a client reading `structuredContent`
    // gets. Whitespace was the only difference, and it was never data.
    const value = { id: "itm_1", nested: { list: [1, 2, 3], flag: false }, nothing: null };
    const result = toolSuccess(value);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
  });

  it("keeps both fields — neither half of the dual emission is dropped", () => {
    // #110 is a serialisation change, explicitly not a removal: no tool
    // declares an `outputSchema`, so the protocol requires `content`, and
    // `structuredContent` is what a client reading data rather than text
    // consumes. A "saving" that dropped either would break real clients.
    const result = toolSuccess({ id: "itm_1" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.structuredContent).toEqual({ id: "itm_1" });
  });

  it("renders the same format regardless of size, rather than switching past a threshold", () => {
    // The rejected alternative was a size-conditional rendering. A tiny and
    // a large payload must serialise the same way, or the wire format
    // becomes a function of how much data happens to exist.
    const small = toolSuccess({ items: [{ id: 0 }] }).content[0]?.text ?? "";
    const large =
      toolSuccess({ items: Array.from({ length: 500 }, (_, i) => ({ id: i })) }).content[0]?.text ??
      "";
    expect(small).not.toContain("\n");
    expect(large).not.toContain("\n");
  });
});

describe("rendering a refusal", () => {
  it("carries the code and fields into structured content and into the text", () => {
    const result = toolRejection(new NotFoundError("No such item.", { fields: ["itemId"] }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "not_found", fields: ["itemId"] });
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      code: "not_found",
      fields: ["itemId"],
      message: "No such item.",
    });
  });

  it("includes the guard identifier when a rule was the refuser", () => {
    const result = toolRejection(new GuardRejectedError("hierarchy", "Too deep.", {}));
    expect(result.structuredContent).toMatchObject({ code: "guard_rejected", guard: "hierarchy" });
  });

  it("omits the guard key entirely when no rule was involved", () => {
    // §22's third assertion is computed from observed `guard` values. A
    // rejection that carried `guard: undefined` for every non-guard
    // refusal would put a key there that means nothing.
    const result = toolRejection(new NotFoundError("Nope.", {}));
    expect(result.structuredContent).not.toHaveProperty("guard");
  });

  it("copies the fields array rather than sharing the error's frozen one", () => {
    // `ServiceError.fields` is frozen. Sharing it would make the rendered
    // result partly immutable in a way a caller serialising it has no
    // reason to expect.
    const error = new NotFoundError("Nope.", { fields: ["a"] });
    const result = toolRejection(error);
    const rendered = result.structuredContent as { fields: string[] };
    expect(rendered.fields).toEqual(["a"]);
    expect(rendered.fields).not.toBe(error.fields);
    expect(() => rendered.fields.push("b")).not.toThrow();
  });

  it("turns a value that is not an error at all into internal", () => {
    // A `throw "string"` or a rejected promise carrying a plain object
    // still has to leave as something a caller can switch on.
    const result = toolRejection("just a string");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "internal" });
  });
});
