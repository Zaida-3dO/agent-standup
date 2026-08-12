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
