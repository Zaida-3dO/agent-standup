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

  it("carries the findings hook_decision returned, for the capture loop", async () => {
    // MILESTONES.md #128: `hook_decision` returns `findings` on every
    // answer, and until this row nothing on this side of the wire read the
    // field at all — it was parsed out of `property(body, ...)` calls for
    // every other key and simply never asked for this one, so a caller
    // wanting the evidence behind a decision had no way to reach it.
    const answer = await ask(
      responding({
        decision: "block",
        findings: [
          {
            id: "I10",
            source: "builtin",
            phase: "pre",
            audience: "agent",
            level: "block-overridable",
            timing: "immediate",
            messages: { plain: "no approval at tip", prominent: "NO APPROVAL AT TIP" },
          },
        ],
      }),
    )(EVENT);
    expect(answer?.findings).toEqual([
      {
        id: "I10",
        source: "builtin",
        phase: "pre",
        audience: "agent",
        level: "block-overridable",
        timing: "immediate",
        messages: { plain: "no approval at tip", prominent: "NO APPROVAL AT TIP" },
      },
    ]);
  });

  it("carries an empty findings array rather than dropping it", async () => {
    // `[]` and "the field was absent" are different facts — an answer that
    // explicitly triggered nothing versus a server too old to send the
    // field at all — and `decideWithNudges` distinguishes them (an
    // explicit `[]` overwrites a previous answer's findings; `undefined`
    // does not). Losing this here would collapse that distinction before
    // it ever reaches `decide.ts`.
    const answer = await ask(responding({ decision: "allow", findings: [] }))(EVENT);
    expect(answer?.findings).toEqual([]);
  });

  it("is absent when the body carries no findings field at all", async () => {
    // An older server that predates #128. `undefined`, not `[]`, so a
    // caller can tell "answered, nothing triggered" apart from "this
    // server has never heard of findings" if it ever needs to.
    const answer = await ask(responding({ decision: "allow" }))(EVENT);
    expect(answer?.findings).toBeUndefined();
  });

  it("drops a finding missing a required field rather than the whole array", async () => {
    // Same posture `readSpool` takes with a torn line: one malformed entry
    // must not cost every other finding in the same answer.
    const answer = await ask(
      responding({
        decision: "allow",
        findings: [
          { id: "I10", phase: "pre", level: "nudge", messages: { plain: "ok" } },
          { phase: "pre", level: "nudge", messages: { plain: "missing its id" } },
          "not an object",
          { id: "I11", phase: "post" /* no level */, messages: { plain: "missing its level" } },
          { id: "I12", phase: "pre", level: "nudge" /* no messages */ },
        ],
      }),
    )(EVENT);
    expect(answer?.findings).toHaveLength(1);
    expect(answer?.findings?.[0]?.id).toBe("I10");
  });

  it("drops the whole findings value when it is not an array", async () => {
    const answer = await ask(responding({ decision: "allow", findings: "I10" }))(EVENT);
    expect(answer?.findings).toBeUndefined();
  });

  it("falls back to the plain message when prominent is missing", async () => {
    // `InterventionMessages` requires both; an older or malformed server
    // response supplying only `plain` must still produce a usable finding
    // rather than being dropped outright, since `buildCaptures` only ever
    // reads `.plain`.
    const answer = await ask(
      responding({
        decision: "allow",
        findings: [{ id: "I7", phase: "post", level: "nudge", messages: { plain: "only plain" } }],
      }),
    )(EVENT);
    expect(answer?.findings?.[0]?.messages).toEqual({
      plain: "only plain",
      prominent: "only plain",
    });
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

// The guard path's own authentication, and its one report.
//
// `POST /api/hook` runs `authenticatedCaller` before it reads the body, so
// on a token-protected deployment a tokenless ask is a `401` forever. The
// two sibling transports (`flush-http.ts`, `record-intervention-http.ts`)
// already send a bearer token; this one did not, which made the guard the
// only part of the hook that could not authenticate — and the failure was
// invisible, because a refused decision allows.
/** The headers of the first call, read without an unchecked index. */
function headersOf(fetch: FetchLike): Record<string, string> {
  const mock = (
    fetch as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }
  ).mock;
  const first = mock.calls[0];
  if (first === undefined) throw new Error("fetch was never called");
  return first[1].headers;
}

describe("authenticating the ask", () => {
  it("sends the token as a bearer header when one is configured", async () => {
    const fetch = responding({ decision: "allow" });
    await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch,
      token: "t-secret",
      timeoutSignal: NO_TIMEOUT,
    })(EVENT);

    const headers = headersOf(fetch);
    expect(headers.authorization).toBe("Bearer t-secret");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sends no authorization header at all when no token is configured", async () => {
    // A deployment with no tokens configured is supported, and an empty
    // `Bearer ` is a header a strict server may reject outright — so the
    // key must be absent rather than present-and-blank.
    const fetch = responding({ decision: "allow" });
    await ask(fetch)(EVENT);

    const headers = headersOf(fetch);
    expect(headers).not.toHaveProperty("authorization");
  });

  it("treats an empty token the same as no token", async () => {
    const fetch = responding({ decision: "allow" });
    await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch,
      token: "",
      timeoutSignal: NO_TIMEOUT,
    })(EVENT);

    const headers = headersOf(fetch);
    expect(headers).not.toHaveProperty("authorization");
  });
});

// Failing open is correct; failing open *silently* is the defect. A `401`
// is otherwise byte-identical to a clean allow, so a hook enforcing nothing
// looks exactly like a hook enforcing everything.
describe("a permanent failure is reported, without changing the decision", () => {
  it("reports a 401 and still allows", async () => {
    const onFailure = vi.fn();
    const verdict = await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch: responding({ error: "unauthorized" }, { ok: false, status: 401 }),
      timeoutSignal: NO_TIMEOUT,
      onFailure,
    })(EVENT);

    // Both halves matter: the caller must still allow (DECISIONS.md §16)
    // AND somebody must have been told.
    expect(verdict).toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith({ status: 401 });
  });

  it("reports a 403 as permanent too", async () => {
    const onFailure = vi.fn();
    await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch: responding({}, { ok: false, status: 403 }),
      timeoutSignal: NO_TIMEOUT,
      onFailure,
    })(EVENT);
    expect(onFailure).toHaveBeenCalledWith({ status: 403 });
  });

  it("stays quiet about a 500 — a server having a bad time is not a misconfiguration", async () => {
    const onFailure = vi.fn();
    await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch: responding({}, { ok: false, status: 500 }),
      timeoutSignal: NO_TIMEOUT,
      onFailure,
    })(EVENT);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stays quiet about 408 and 429 — 4xx by number, transient by meaning", async () => {
    // Crying wolf about a timeout or a rate limit on every tool call would
    // train a reader to ignore the line that matters.
    const onFailure = vi.fn();
    for (const status of [408, 429]) {
      await createHttpAsk({
        baseUrl: "http://server.invalid",
        fetch: responding({}, { ok: false, status }),
        timeoutSignal: NO_TIMEOUT,
        onFailure,
      })(EVENT);
    }
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stays quiet when the server is simply unreachable", async () => {
    // A laptop between networks is the ordinary condition, not a
    // misconfiguration, and there is no status to report anyway.
    const onFailure = vi.fn();
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch,
      timeoutSignal: NO_TIMEOUT,
      onFailure,
    })(EVENT);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not report a success, and does not require a callback to work", async () => {
    const onFailure = vi.fn();
    const verdict = await createHttpAsk({
      baseUrl: "http://server.invalid",
      fetch: responding({ decision: "block", reason: "nope" }),
      timeoutSignal: NO_TIMEOUT,
      onFailure,
    })(EVENT);

    expect(verdict?.decision).toBe("block");
    expect(onFailure).not.toHaveBeenCalled();
    // The callback is optional: a 401 with no `onFailure` must not throw.
    await expect(ask(responding({}, { ok: false, status: 401 }))(EVENT)).resolves.toBeUndefined();
  });
});
