// MILESTONES.md #125 — the transport that asks `POST /api/hook`
// (`src/lib/hook/ask-http.ts`).
//
// Two properties, and they pull in opposite directions, which is why both
// need asserting:
//
//   - **Every failure returns `undefined`.** The caller reads that as "no
//     answer" and, under DECISIONS.md §16, allows. The failures worth
//     enumerating are the ones a plausible implementation forgets: a 500
//     whose body happens to parse, and a body that is JSON but not an
//     object.
//   - **Only the literal string `block` blocks.** Everything else —
//     including a decision value this build has never seen — is read as an
//     allow rather than as an error. That is what stops a newer server
//     adding a fourth decision from turning every call in an un-updated
//     installation into a refusal, and it is the single assertion most
//     likely to be lost to a "tidy up the parsing" change.
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
  it("posts the event's facts to /api/hook", async () => {
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

  it("sends a tool result when the event carries one", async () => {
    const fetch = responding({ decision: "allow" });
    await ask(fetch)({ ...EVENT, eventType: "PostToolUse", toolResult: "3 files changed" });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body).toolResult).toBe("3 files changed");
  });

  it("omits tool and command entirely for an event that has none", async () => {
    // The route's input schema is `.strict()` and both fields are
    // `.min(1)`, so sending them as empty strings would be rejected as
    // invalid input — which reaches the caller as a non-success status, and
    // therefore as an outage rather than as the answer it really was.
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

  it("reads a block with its reason", async () => {
    const answer = await ask(responding({ decision: "block", reason: "no review at tip" }))(EVENT);
    expect(answer?.decision).toBe("block");
    expect(answer?.reason).toBe("no review at tip");
  });

  it("carries session enforcement the server volunteered", async () => {
    const answer = await ask(
      responding({ decision: "allow", enforcement: { status: "displaced", detail: "s-9" } }),
    )(EVENT);
    expect(answer?.enforcement).toEqual({ status: "displaced", detail: "s-9" });
  });

  it("carries a nudge context the server volunteered", async () => {
    const answer = await ask(responding({ decision: "allow", nudge: { budgetBand: "wind-down" } }))(
      EVENT,
    );
    expect(answer?.nudge).toEqual({ budgetBand: "wind-down" });
  });

  it("drops a malformed nudge block without touching the decision", async () => {
    const answer = await ask(responding({ decision: "block", nudge: "not an object" }))(EVENT);
    expect(answer?.decision).toBe("block");
    expect(answer?.nudge).toBeUndefined();
  });
});

describe("only `block` blocks", () => {
  it("reads a decision this build does not recognise as an allow", async () => {
    // The §16 case: a newer server adds a decision value. An un-updated
    // script must not refuse on it. `undefined` would be wrong here too —
    // that is the shape reserved for "the server did not answer", and this
    // server did.
    for (const decision of ["maybe", "escalate", "deny", true, 7, null]) {
      const answer = await ask(responding({ decision }))(EVENT);
      expect(answer?.decision, String(decision)).toBe("allow");
    }
  });

  it("reads a body with no decision field as an allow", async () => {
    expect((await ask(responding({}))(EVENT))?.decision).toBe("allow");
    expect((await ask(responding({ reason: "just talking" }))(EVENT))?.decision).toBe("allow");
  });

  it("is case- and whitespace-sensitive about the one word that refuses", async () => {
    // A near-miss must not block. If this ever needs to be lenient it is a
    // protocol change, not a parsing tweak.
    for (const decision of ["Block", "BLOCK", " block", "blocked"]) {
      expect((await ask(responding({ decision }))(EVENT))?.decision, decision).toBe("allow");
    }
  });
});

describe("every failure is no answer, which the caller allows on", () => {
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

  it("returns undefined when the body is not an object", async () => {
    // Distinct from "an object with no decision", which is a server that
    // answered and is read as an allow. These carry nothing readable at
    // all, so they are honestly reported as no answer — both allow, but
    // only one of them names an outage in its reason.
    expect(await ask(responding(null))(EVENT)).toBeUndefined();
    expect(await ask(responding("a string"))(EVENT)).toBeUndefined();
    expect(await ask(responding([{ decision: "block" }]))(EVENT)).toBeUndefined();
  });
});
