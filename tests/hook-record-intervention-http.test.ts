// MILESTONES.md #128's capture loop, client half — sending one decision's
// captures (`src/lib/hook/record-intervention-http.ts`).
//
// Same posture as `tests/hook-flush-http.test.ts`, over the sibling sender:
// shape the request, reduce every failure to `false`, authenticate when a
// token is configured. The one property this row's design turns on and
// `flush-http` has no equivalent of: **a capture is never spooled**, so
// there is no retry and no `onFailure` — a failed send is simply a lost
// capture, silently, and that silence is asserted here rather than assumed.
import { describe, expect, it, vi } from "vitest";
import {
  createRecordInterventionHttp,
  toWireBatch,
  DEFAULT_RECORD_TIMEOUT_MS,
  type FetchLike,
  type InterventionCaptureBatch,
} from "@/lib/hook/record-intervention-http";
import { DEFAULT_TIMEOUT_MS as DEFAULT_ASK_TIMEOUT_MS } from "@/lib/hook/ask-http";
import type { InterventionCapture } from "@/lib/interventions/capture";

function capture(overrides: Partial<InterventionCapture> = {}): InterventionCapture {
  return {
    entryId: "I10",
    sessionId: "s-1",
    outcome: "blocked",
    level: "block-overridable",
    phase: "pre",
    tool: "Bash",
    command: "git merge main",
    message: "no approval at tip",
    ...overrides,
  };
}

const BATCH: InterventionCaptureBatch = { sessionId: "s-1", captures: [capture()] };

function stubFetch(status: number, ok = status >= 200 && status < 300) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status };
  };
  return { fetch, calls };
}

describe("the request is shaped the way record_intervention accepts it", () => {
  it("posts to the interventions route", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    await send(BATCH);

    expect(calls[0]?.url).toBe("https://standup.example/api/interventions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
  });

  it("hoists sessionId onto the envelope and drops it from each capture", () => {
    // `record_intervention`'s schema is strict — `sessionId` on a capture
    // entry is an unrecognised key, not a redundant one, and would refuse
    // the whole batch.
    const wire = toWireBatch(BATCH);
    expect(wire.sessionId).toBe("s-1");
    const captures = wire.captures as Record<string, unknown>[];
    expect(captures[0]?.sessionId).toBeUndefined();
  });

  it("carries rootSessionId on the envelope only when the batch has one", () => {
    expect(toWireBatch(BATCH).rootSessionId).toBeUndefined();
    expect(toWireBatch({ ...BATCH, rootSessionId: "root-1" }).rootSessionId).toBe("root-1");
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example/", fetch });

    await send(BATCH);
    expect(calls[0]?.url).toBe("https://standup.example/api/interventions");
  });

  it("treats the created status as success", async () => {
    const { fetch } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });
    expect(await send(BATCH)).toBe(true);
  });

  it("does not call fetch at all for an empty batch", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    expect(await send({ sessionId: "s-1", captures: [] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("every failure answers false, and nothing retries", () => {
  it("answers false on a refused shape, with no onFailure to tell why", async () => {
    // Unlike a flush, a capture is not spooled and nothing calls this
    // sender again for the same finding — so there is deliberately no
    // failure-reason channel to build here.
    const { fetch } = stubFetch(400, false);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });
    expect(await send(BATCH)).toBe(false);
  });

  it("answers false without throwing when the server is unreachable", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });
    expect(await send(BATCH)).toBe(false);
  });
});

describe("the request is bounded in time", () => {
  it("passes an abort signal built from the configured timeout", async () => {
    const timeoutSignal = vi.fn(() => undefined);
    const { fetch } = stubFetch(201);
    const send = createRecordInterventionHttp({
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
    const send = createRecordInterventionHttp({
      baseUrl: "https://standup.example",
      fetch,
      timeoutSignal,
    });

    await send(BATCH);
    expect(timeoutSignal).toHaveBeenCalledWith(DEFAULT_RECORD_TIMEOUT_MS);
    expect(DEFAULT_RECORD_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("does not borrow the decision's full patience for a lost capture", () => {
    // Row a5af3691: a lost capture costs strictly less than a delayed tool
    // call, so this ceiling must stay materially below `ask-http.ts`'s
    // `DEFAULT_TIMEOUT_MS` rather than copying it — otherwise a hung
    // capture server costs a real tool call the decision's *own* worst-case
    // wait a second time. Pinned as a relationship, not a literal number,
    // so either constant can move without this test silently going stale.
    expect(DEFAULT_RECORD_TIMEOUT_MS).toBeLessThan(DEFAULT_ASK_TIMEOUT_MS);
  });
});

describe("the sender authenticates when the deployment requires it", () => {
  it("sends the token as a bearer credential", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({
      baseUrl: "https://standup.example",
      fetch,
      token: "t-secret",
    });

    await send(BATCH);
    expect(calls[0]?.init.headers.authorization).toBe("Bearer t-secret");
  });

  it("sends no authorization header at all when there is no token", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    await send(BATCH);
    expect(calls[0]?.init.headers.authorization).toBe(undefined);
  });

  it("treats a blank token as no token rather than sending an empty bearer", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({
      baseUrl: "https://standup.example",
      fetch,
      token: "",
    });

    await send(BATCH);
    expect(calls[0]?.init.headers.authorization).toBe(undefined);
  });
});
