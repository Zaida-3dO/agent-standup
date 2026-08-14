// MILESTONES.md #98 — the `standup item artifact` and
// `standup item request-review` verbs: the `buildInput` half of each entry,
// at the level `cli-item-verbs.test.ts` exercises the other item verbs at.
//
// This proves what each command turns typed words and flags into *before* a
// binding is reached. It does not re-prove dispatch, aliasing or the
// envelope plumbing — those stay covered by #79's own files.
//
// Needs no database: everything here is a pure function of words and flags.
import { describe, expect, it } from "vitest";
import { COMMANDS, HTTP_ROUTES, lookupCommand } from "@/lib/cli";

function commandFor(noun: string, verb: string) {
  const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!command) throw new Error(`no such command: ${noun} ${verb}`);
  return command;
}

describe("item artifact", () => {
  const artifact = commandFor("item", "artifact");

  it("calls the record_artifact operation", () => {
    expect(artifact.operation).toBe("record_artifact");
  });

  it("refuses with no item id, before any flag is read", () => {
    const built = artifact.buildInput([], { kind: "commit" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["itemId"]);
  });

  it("puts the id from the words and the rest of the flags into one input object", () => {
    const built = artifact.buildInput(["item-1"], {
      kind: "code_review",
      verdict: "lgtm",
      commitSha: "sha-1",
    });
    expect(built).toEqual({
      ok: true,
      input: { itemId: "item-1", kind: "code_review", verdict: "lgtm", commitSha: "sha-1" },
    });
  });

  it("maps --session onto sessionId and drops the other global flags", () => {
    const built = artifact.buildInput(["item-1"], {
      kind: "plan",
      session: "session-7",
      json: true,
      as: "user-a",
    });
    expect(built).toEqual({
      ok: true,
      input: { itemId: "item-1", kind: "plan", sessionId: "session-7" },
    });
  });

  it("passes a numeric flag straight through as the string it arrived as", () => {
    const built = artifact.buildInput(["item-1"], { kind: "plan", reviewRound: "3" });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    // Deliberately NOT coerced here. The operation's schema declares
    // `z.coerce.number()`, so the conversion happens once, in the place every
    // adapter shares — a second conversion here is the thing that drifts the
    // day the schema changes what it accepts.
    expect((built.input as { reviewRound: unknown }).reviewRound).toBe("3");
  });

  it("refuses a bare value-taking flag", () => {
    const built = artifact.buildInput(["item-1"], { kind: true });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["kind"]);
  });

  it("is reachable by the words a user types", () => {
    const found = lookupCommand(["item", "artifact", "item-1"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("record_artifact");
    expect(found.match.rest).toEqual(["item-1"]);
  });
});

describe("item request-review", () => {
  const request = commandFor("item", "request-review");

  it("calls the request_review operation", () => {
    expect(request.operation).toBe("request_review");
  });

  it("refuses with no item id", () => {
    const built = request.buildInput([], {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["itemId"]);
  });

  it("builds the input from the id and the flags", () => {
    const built = request.buildInput(["item-1"], { round: "2", session: "session-7" });
    expect(built).toEqual({
      ok: true,
      input: { itemId: "item-1", round: "2", sessionId: "session-7" },
    });
  });

  it("is reachable by the words a user types", () => {
    const found = lookupCommand(["item", "request-review", "item-1"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("request_review");
  });
});

describe("the http binding can reach both operations", () => {
  it("routes record_artifact to the item-scoped artifacts endpoint", () => {
    const route = HTTP_ROUTES.record_artifact;
    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    const built = route?.request({ itemId: "item-1", kind: "commit", commitSha: "sha-1" });
    expect(built?.path).toBe("/api/items/item-1/artifacts");
    // `itemId` is in the path, so it is NOT also in the body — two copies
    // could disagree, and the body's would be the one silently ignored.
    expect(built?.body).toEqual({ kind: "commit", commitSha: "sha-1" });
    expect(route?.unwrap({ artifact: { id: "a-1" } })).toEqual({ id: "a-1" });
  });

  it("percent-encodes an item id that needs it", () => {
    const built = HTTP_ROUTES.record_artifact?.request({ itemId: "a/b", kind: "plan" });
    // Without encoding this would read as a nested path and reach a
    // different endpoint entirely.
    expect(built?.path).toBe("/api/items/a%2Fb/artifacts");
  });

  it("routes request_review to the item-scoped review-requests endpoint", () => {
    const route = HTTP_ROUTES.request_review;
    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    const built = route?.request({ itemId: "item-1", round: 2 });
    expect(built?.path).toBe("/api/items/item-1/review-requests");
    expect(built?.body).toEqual({ round: 2 });
    expect(route?.unwrap({ event: { id: "1" } })).toEqual({ id: "1" });
  });
});
