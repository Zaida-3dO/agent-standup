// MILESTONES.md #100 — the `standup item loop` and `item loop-close` verbs:
// the `buildInput` half of each entry, at the level `cli-item-verbs.test.ts`
// exercises the other item verbs at.
//
// Needs no database: everything here is a pure function of words and flags.
import { describe, expect, it } from "vitest";
import { COMMANDS, HTTP_ROUTES, lookupCommand } from "@/lib/cli";

function commandFor(noun: string, verb: string) {
  const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!command) throw new Error(`no such command: ${noun} ${verb}`);
  return command;
}

describe("item loop", () => {
  const loop = commandFor("item", "loop");

  it("calls the loop_add operation", () => {
    expect(loop.operation).toBe("loop_add");
  });

  it("refuses with no item id", () => {
    const built = loop.buildInput([], {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["itemId"]);
  });

  it("joins the trailing words into the loop text", () => {
    const built = loop.buildInput(["item-1", "the", "retry", "path", "is", "untested"], {});
    expect(built).toEqual({
      ok: true,
      input: { itemId: "item-1", text: "the retry path is untested" },
    });
  });

  it("leaves text absent when no words follow, so the schema refuses it", () => {
    const built = loop.buildInput(["item-1"], {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    // Field validation belongs in the operation's schema, not in buildInput
    // (§20) — so this builds successfully and `loop_add` is what rejects it.
    expect(built.input).toEqual({ itemId: "item-1" });
  });

  it("maps --session onto sessionId and drops the other global flags", () => {
    const built = loop.buildInput(["item-1", "x"], {
      session: "session-7",
      json: true,
      as: "user-a",
    });
    expect(built).toEqual({
      ok: true,
      input: { itemId: "item-1", text: "x", sessionId: "session-7" },
    });
  });

  it("passes an explicit --loopId through", () => {
    const built = loop.buildInput(["item-1", "x"], { loopId: "my-id" });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect((built.input as { loopId: string }).loopId).toBe("my-id");
  });

  it("is reachable by the words a user types", () => {
    const found = lookupCommand(["item", "loop", "item-1", "some", "text"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("loop_add");
    expect(found.match.rest).toEqual(["item-1", "some", "text"]);
  });
});

describe("item loop-close", () => {
  const close = commandFor("item", "loop-close");

  it("calls the loop_close operation", () => {
    expect(close.operation).toBe("loop_close");
  });

  it("reads the loop id from the second positional", () => {
    const built = close.buildInput(["item-1", "loop-7"], {});
    expect(built).toEqual({ ok: true, input: { itemId: "item-1", loopId: "loop-7" } });
  });

  it("leaves loopId absent when not given, so the schema refuses it", () => {
    const built = close.buildInput(["item-1"], {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.input).toEqual({ itemId: "item-1" });
  });

  it("refuses with no item id", () => {
    const built = close.buildInput([], {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["itemId"]);
  });
});

describe("the http binding can reach both operations", () => {
  it("routes loop_add to the item-scoped loops endpoint", () => {
    const route = HTTP_ROUTES.loop_add;
    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    const built = route?.request({ itemId: "item-1", text: "x" });
    expect(built?.path).toBe("/api/items/item-1/loops");
    // `itemId` is in the path, so not also in the body.
    expect(built?.body).toEqual({ text: "x" });
  });

  it("keeps the whole loop_add body, because loopId is the half the caller needs", () => {
    const body = { loopId: "generated-1", event: { id: "5" } };
    // Unwrapping to `event` would discard the generated id, leaving the
    // caller holding a loop it can never close.
    expect(HTTP_ROUTES.loop_add?.unwrap(body)).toEqual(body);
  });

  it("routes loop_close to the close sub-path, with both ids encoded", () => {
    const route = HTTP_ROUTES.loop_close;
    expect(route).toBeDefined();
    const built = route?.request({ itemId: "a/b", loopId: "c d", sessionId: "s-1" });
    // Both segments are percent-encoded: an unencoded id would read as a
    // nested path and reach a different endpoint entirely.
    expect(built?.path).toBe("/api/items/a%2Fb/loops/c%20d/close");
    expect(built?.body).toEqual({ sessionId: "s-1" });
    expect(route?.unwrap({ event: { id: "6" } })).toEqual({ id: "6" });
  });
});
