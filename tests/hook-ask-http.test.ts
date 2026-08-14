// MILESTONES.md #42 — the transport that asks `POST /hook`
// (`src/lib/hook/ask-http.ts`).
//
// One property, asserted many ways: **every failure returns `undefined`**,
// which the caller reads as "no answer" and denies. The failures worth
// enumerating are the ones a plausible implementation forgets — a 500 whose
// body happens to parse, a body that is JSON but carries no decision, and a
// server that answered `ask`, which is a server that did not resolve the
// question it was asked.
import { describe, expect, it, vi } from "vitest";
import { createHttpAsk, type FetchLike } from "@/lib/hook/ask-http";
import type { HookEvent } from "@/lib/hook/payload";

const EVENT: HookEvent = {
  eventType: "PreToolUse",
  sessionId: "s-1",
  tool: "Bash",
  command: "git push",
};

function responding(body: unknown, init: { ok?: boolean; status?: number } = {}): FetchLike {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
}

const NO_TIMEOUT = () => undefined;

function ask(fetch: FetchLike) {
  return createHttpAsk({ baseUrl: "http://server.invalid", fetch, timeoutSignal: NO_TIMEOUT });
}

describe("the request", () => {
  it("posts the event's four facts to /api/hook", async () => {
    const fetch = responding({ decision: "allow" });
    await ask(fetch)(EVENT);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("http://server.invalid/api/hook");
    expect(init.method).toBe("POST");
    // SCHEMA.md §19: "Sends event type, session, tool, command."
    expect(JSON.parse(init.body)).toEqual({
      eventType: "PreToolUse",
      sessionId: "s-1",
      tool: "Bash",
      command: "git push",
    });
  });

  it("does not append a second slash when the base URL already ends in one", async () => {
    const fetch = responding({ decision: "allow" });
    await createHttpAsk({
      baseUrl: "http://server.invalid/",
      fetch,
      timeoutSignal: NO_TIMEOUT,
    })(EVENT);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://server.invalid/api/hook");
  });

  it("omits tool and command entirely for an event that has none", async () => {
    // The route's input schema is `.strict()` and both fields are
    // `.min(1)`, so sending them as empty strings would be rejected as
    // invalid input — which reaches the caller as a non-success status and
    // therefore a deny, on an event that should have been allowed.
    const fetch = responding({ decision: "allow" });
    await ask(fetch)({ eventType: "Stop", sessionId: "s-1" });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body)).toEqual({ eventType: "Stop", sessionId: "s-1" });
  });

  it("makes exactly one attempt — no retry on the critical path of every tool call", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    await ask(fetch)(EVENT);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("the answer, when there is one", () => {
  it("reads an allow with its reason", async () => {
    const answer = await ask(responding({ decision: "allow", reason: "you own this branch" }))(
      EVENT,
    );
    expect(answer).toEqual({ decision: "allow", reason: "you own this branch" });
  });

  it("reads a deny with its reason", async () => {
    const answer = await ask(responding({ decision: "deny", reason: "no review at tip" }))(EVENT);
    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toBe("no review at tip");
  });

  it("carries rules the server volunteered", async () => {
    const answer = await ask(
      responding({ decision: "allow", allowPatterns: ["^ls$"], askPatterns: [] }),
    )(EVENT);
    expect(answer?.rules).toEqual({ allowPatterns: ["^ls$"], askPatterns: [] });
  });

  it("drops volunteered rules that do not validate rather than caching them", async () => {
    const answer = await ask(
      responding({ decision: "allow", allowPatterns: ["([unclosed"], askPatterns: [] }),
    )(EVENT);
    expect(answer?.decision).toBe("allow");
    expect(answer?.rules).toBeUndefined();
  });

  it("carries session enforcement the server volunteered", async () => {
    const answer = await ask(
      responding({ decision: "allow", enforcement: { status: "displaced", detail: "s-9" } }),
    )(EVENT);
    expect(answer?.enforcement).toEqual({ status: "displaced", detail: "s-9" });
  });

  it("reads the server's `ask` as a deny", async () => {
    // The service layer's third outcome means "a rule must decide". By the
    // time the route has answered, the deciding is done — so an `ask` coming
    // back is a server that did not resolve the question. Anything softer
    // than a deny would make "the server was unsure" the one kind of
    // uncertainty this hook permits.
    const answer = await ask(responding({ decision: "ask", matchedPattern: "^git push" }))(EVENT);
    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toContain("did not resolve");
  });
});

describe("every failure is no answer, which the caller denies on", () => {
  it("returns undefined when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    expect(await ask(fetch)(EVENT)).toBeUndefined();
  });

  it("returns undefined on a non-success status even when the body parses", async () => {
    // The one a plausible implementation forgets: an error page whose body
    // happens to contain a `decision` field would otherwise be honoured.
    const fetch = responding({ decision: "allow" }, { ok: false, status: 500 });
    expect(await ask(fetch)(EVENT)).toBeUndefined();
  });

  it("returns undefined when the body is not JSON", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    })) as unknown as FetchLike;
    expect(await ask(fetch)(EVENT)).toBeUndefined();
  });

  it("returns undefined when the body carries no decision", async () => {
    expect(await ask(responding({ matchedList: "ask" }))(EVENT)).toBeUndefined();
    expect(await ask(responding({}))(EVENT)).toBeUndefined();
    expect(await ask(responding(null))(EVENT)).toBeUndefined();
  });

  it("returns undefined for a decision this build does not recognise", async () => {
    // A future server value must not be silently coerced. Anything not in
    // the known three is no answer, and no answer denies.
    expect(await ask(responding({ decision: "maybe" }))(EVENT)).toBeUndefined();
    expect(await ask(responding({ decision: true }))(EVENT)).toBeUndefined();
  });
});
