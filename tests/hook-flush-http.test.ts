// MILESTONES.md #88 — sending a flush batch (`src/lib/hook/flush-http.ts`).
//
// **The asymmetry that makes these tests worth having: a failed flush is
// silent.** A failed *ask* denies a tool call, so it announces itself. A
// failed flush just leaves records spooled, and they are retried — which is
// correct, and which is also why a batch the server will refuse *forever*
// looks exactly like a server that is briefly down. The difference matters:
// one resolves itself and the other fills the spool to its ceiling and
// starts dropping the oldest records. So the permanent/transient split is
// pinned here rather than left to the caller to infer.
import { describe, expect, it, vi } from "vitest";
import { createHttpFlush, DEFAULT_FLUSH_TIMEOUT_MS, type FetchLike } from "@/lib/hook/flush-http";
import type { FlushFailure } from "@/lib/hook/flush-http";
import type { ToolCallBatch } from "@/lib/hook/flush";

const BATCH: ToolCallBatch = {
  sessionId: "session-a",
  calls: [
    {
      tool: "Bash",
      ts: "2026-01-01T00:00:00.000Z",
      command: "git status",
      inputTokens: 1,
      outputTokens: 2,
      cacheWriteTokens: 3,
      cacheReadTokens: 4,
    },
  ],
};

/** A `fetch` that answers with one status and records what it was called with. */
function stubFetch(status: number, ok = status >= 200 && status < 300) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status };
  };
  return { fetch, calls };
}

describe("the request is shaped the way the ingest accepts it", () => {
  it("posts the envelope verbatim to the tool-calls route", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch });

    await send(BATCH);

    expect(calls[0]?.url).toBe("https://standup.example/api/tool-calls");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
    // The body is the batch exactly — `sessionId` on the envelope, `calls`
    // beneath it. Anything else is an unrecognised key to a strict schema.
    expect(JSON.parse(calls[0]?.init.body ?? "")).toEqual(BATCH);
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    // A configured URL routinely ends in `/`, and `//api/tool-calls` is a
    // different path — one that would 404 on every flush forever.
    const { fetch, calls } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example/", fetch });

    await send(BATCH);
    expect(calls[0]?.url).toBe("https://standup.example/api/tool-calls");
  });

  it("treats the created status as success", async () => {
    // The route answers `201`, not `200`, because the call creates rows. A
    // sender checking for `200` specifically would retry every successful
    // flush forever and duplicate every row.
    const { fetch } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch });
    expect(await send(BATCH)).toBe(true);
  });
});

describe("every failure answers false, and says which kind it was", () => {
  it("reports a refused shape as permanent", async () => {
    // The silent-forever case: the server is up and refusing this body.
    // Retrying cannot fix it, and without this distinction nothing would
    // ever say so.
    const failures: FlushFailure[] = [];
    const { fetch } = stubFetch(400, false);
    const send = createHttpFlush({
      baseUrl: "https://standup.example",
      fetch,
      onFailure: (failure) => failures.push(failure),
    });

    expect(await send(BATCH)).toBe(false);
    expect(failures).toEqual([{ status: 400, permanent: true }]);
  });

  it("reports a server error as transient", async () => {
    const failures: FlushFailure[] = [];
    const { fetch } = stubFetch(503, false);
    const send = createHttpFlush({
      baseUrl: "https://standup.example",
      fetch,
      onFailure: (failure) => failures.push(failure),
    });

    expect(await send(BATCH)).toBe(false);
    expect(failures).toEqual([{ status: 503, permanent: false }]);
  });

  it("treats a timeout and a rate limit as transient despite being 4xx", async () => {
    // Both are `4xx` by number and transient by meaning: the identical body
    // succeeds on a later attempt. Calling them permanent would abandon
    // records the server never actually refused.
    for (const status of [408, 429]) {
      const failures: FlushFailure[] = [];
      const { fetch } = stubFetch(status, false);
      const send = createHttpFlush({
        baseUrl: "https://standup.example",
        fetch,
        onFailure: (failure) => failures.push(failure),
      });

      expect(await send(BATCH)).toBe(false);
      expect(failures[0]?.permanent).toBe(false);
    }
  });

  it("answers false without throwing when the server is unreachable", async () => {
    // A throw here would propagate out of the flush loop and take down
    // whatever ran it — telemetry is not allowed to do that.
    const failures: FlushFailure[] = [];
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const send = createHttpFlush({
      baseUrl: "https://standup.example",
      fetch,
      onFailure: (failure) => failures.push(failure),
    });

    expect(await send(BATCH)).toBe(false);
    // Never permanent: there is no evidence the server would refuse this
    // body, so discarding over a flaky network would lose real telemetry.
    expect(failures).toEqual([{ permanent: false }]);
  });

  it("does not require an onFailure callback", async () => {
    const { fetch } = stubFetch(500, false);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch });
    expect(await send(BATCH)).toBe(false);
  });
});

describe("the request is bounded in time", () => {
  it("passes an abort signal built from the configured timeout", async () => {
    // A flush that hangs forever holds a process open and never retries.
    const timeoutSignal = vi.fn(() => undefined);
    const { fetch } = stubFetch(201);
    const send = createHttpFlush({
      baseUrl: "https://standup.example",
      fetch,
      timeoutMs: 1234,
      timeoutSignal,
    });

    await send(BATCH);
    expect(timeoutSignal).toHaveBeenCalledWith(1234);
  });

  it("defaults to a bounded timeout rather than none", async () => {
    const timeoutSignal = vi.fn(() => undefined);
    const { fetch } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch, timeoutSignal });

    await send(BATCH);
    expect(timeoutSignal).toHaveBeenCalledWith(DEFAULT_FLUSH_TIMEOUT_MS);
    expect(DEFAULT_FLUSH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ── The bearer token (row 636f640b) ────────────────────────────────────
//
// `POST /api/tool-calls` authenticates unconditionally. A flush that sends
// no token is refused `401`, and `401` is `4xx` — which `isPermanent`
// classifies as permanent, correctly. So a tokenless flush against an
// authenticating deployment is the quietest failure available: every batch
// rejected forever, the spool filling to its ceiling and dropping its
// oldest records, and nothing anywhere saying why.
describe("the flush authenticates when the deployment requires it", () => {
  it("sends the token as a bearer credential", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createHttpFlush({
      baseUrl: "https://standup.example",
      fetch,
      token: "t-secret",
    });

    await send(BATCH);
    expect(calls[0]?.init.headers.authorization).toBe("Bearer t-secret");
  });

  it("sends no authorization header at all when there is no token", async () => {
    // Absent rather than empty: an `Authorization: Bearer ` with nothing
    // after it is a *malformed* credential, which a server may refuse
    // differently from an absent one. A deployment with no tokens
    // configured is still supported.
    const { fetch, calls } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch });

    await send(BATCH);
    expect(calls[0]?.init.headers.authorization).toBe(undefined);
  });

  it("treats a blank token as no token rather than sending an empty bearer", () => {
    const { fetch, calls } = stubFetch(201);
    const send = createHttpFlush({ baseUrl: "https://standup.example", fetch, token: "" });

    return send(BATCH).then(() => {
      expect(calls[0]?.init.headers.authorization).toBe(undefined);
    });
  });
});
