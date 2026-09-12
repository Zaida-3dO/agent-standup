// MILESTONES.md #128's capture loop, client half — sending one decision's
// captures (`src/lib/hook/record-intervention-http.ts`).
//
// Same posture as `tests/hook-flush-http.test.ts`, over the sibling sender:
// shape the request, reduce every failure to a not-ok result, authenticate
// when a token is configured. The one property this row's design turns on
// and `flush-http` has no equivalent of: **a capture is never spooled**, so
// there is no retry and no `onFailure` — a failed send is simply a lost
// capture, silently, and that silence is asserted here rather than assumed.
//
// The sender also reads the row ids back off the response, and the group at
// the bottom covers that: those ids are the only handle anything has on a
// firing, so a sender that dropped them would leave every firing it
// recorded impossible to score.
import { describe, expect, it, vi } from "vitest";
import {
  createRecordInterventionHttp,
  toWireBatch,
  DEFAULT_RECORD_TIMEOUT_MS,
  readRecordedFirings,
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

function stubFetch(
  status: number,
  ok = status >= 200 && status < 300,
  body: unknown = { recorded: [] },
) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
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
    expect((await send(BATCH)).ok).toBe(true);
  });

  it("does not call fetch at all for an empty batch", async () => {
    const { fetch, calls } = stubFetch(201);
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    expect((await send({ sessionId: "s-1", captures: [] })).ok).toBe(true);
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
    expect((await send(BATCH)).ok).toBe(false);
  });

  it("answers false without throwing when the server is unreachable", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });
    expect((await send(BATCH)).ok).toBe(false);
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

// ── The override reason on the wire ─────────────────────────────────────
//
// The last link in the chain. `record_intervention` has accepted an
// `overrideReason` since the operation was written and the column has always
// existed; what was missing was anything putting the field into the request
// body. A capture that reached this function with a reason and left without
// one would lose it silently, since the adapter reduces every answer to a
// boolean and nothing downstream can tell an absent field from an absent
// reason.
describe("the override reason reaches the request body", () => {
  const REASON = "the kill is scoped to one pid this guard misread as broad";

  // Kills: omitting `overrideReason` from `toWireBatch`'s projection — the
  // shape of the original gap, one layer further down. Asserts the value,
  // not merely that the key is set.
  it("forwards the reason verbatim on an overridden capture", () => {
    const wire = toWireBatch({
      sessionId: "s-1",
      captures: [capture({ outcome: "overridden", overrideReason: REASON })],
    });

    const captures = wire.captures as Record<string, unknown>[];
    expect(captures[0]?.outcome).toBe("overridden");
    expect(captures[0]?.overrideReason).toBe(REASON);
  });

  // `record_intervention`'s capture schema is `.strict()`, and its
  // `overrideReason` is `.min(1)` — so an explicit `undefined` or an empty
  // string would refuse the whole batch rather than storing nothing. The key
  // must be absent, not present-and-empty.
  it("omits the key entirely on a capture that carried no override", () => {
    const wire = toWireBatch({ sessionId: "s-1", captures: [capture()] });

    const captures = wire.captures as Record<string, unknown>[];
    expect(captures[0]).not.toHaveProperty("overrideReason");
  });
});

// ── The row ids come back ───────────────────────────────────────────────
//
// The seam that decides whether a firing is scoreable at all. Everything
// that attributes a judgement to a firing — the scale, the session-end
// survey, `score_intervention` — names it by the id this response carries,
// so a sender that read only the status would write evidence into a table
// and leave nothing able to address it.
//
// The direction of every assertion below is the same: a malformed entry
// costs its own id and nothing else, and an unreadable body is reported as
// the successful write it was rather than as a lost capture.
describe("the sender reads the recorded row ids back", () => {
  it("returns the ids the server reported", async () => {
    const { fetch } = stubFetch(201, true, {
      recorded: [
        { id: "41", entryId: "I10" },
        { id: "42", entryId: "I14" },
      ],
    });
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    const result = await send(BATCH);

    expect(result.ok).toBe(true);
    expect(result.recorded).toEqual([
      { id: "41", entryId: "I10" },
      { id: "42", entryId: "I14" },
    ]);
  });

  it("reports a successful write whose body could not be parsed as written, not lost", async () => {
    // The rows exist — the server said so with its status. Answering
    // `ok: false` here would tell the caller the capture was lost when it
    // was not; what was lost is the ids, which is the weaker and accurate
    // statement.
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error("not json");
      },
    });
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    const result = await send(BATCH);

    expect(result.ok).toBe(true);
    expect(result.recorded).toEqual([]);
  });

  it("reports no ids for a failed send, so a lost capture cannot look recorded", async () => {
    const { fetch } = stubFetch(400, false, { recorded: [{ id: "41", entryId: "I10" }] });
    const send = createRecordInterventionHttp({ baseUrl: "https://standup.example", fetch });

    const result = await send(BATCH);

    expect(result.ok).toBe(false);
    expect(result.recorded).toEqual([]);
  });
});

describe("reading ids off a body keeps the good entries and drops the bad", () => {
  it("drops an entry with no id but keeps its siblings", () => {
    expect(
      readRecordedFirings({
        recorded: [{ entryId: "I10" }, { id: "42", entryId: "I14" }],
      }),
    ).toEqual([{ id: "42", entryId: "I14" }]);
  });

  it("drops an entry whose id is blank rather than trusting an empty handle", () => {
    // A blank id is worse than a missing one: it is a string, so a reader
    // that only checked the type would write a score against `""`.
    expect(readRecordedFirings({ recorded: [{ id: "   ", entryId: "I10" }] })).toEqual([]);
  });

  it("drops an entry whose id is a number, since the handle travels as a string", () => {
    // The column is a bigint and the operation stringifies it precisely so
    // no precision is lost in transit. Accepting a raw number here would
    // undo that at the last step.
    expect(readRecordedFirings({ recorded: [{ id: 42, entryId: "I10" }] })).toEqual([]);
  });

  it("trims surrounding whitespace off an id rather than keeping an unusable one", () => {
    expect(readRecordedFirings({ recorded: [{ id: " 42 ", entryId: " I14 " }] })).toEqual([
      { id: "42", entryId: "I14" },
    ]);
  });

  it("yields nothing for a body that is not the expected shape", () => {
    expect(readRecordedFirings(null)).toEqual([]);
    expect(readRecordedFirings("recorded")).toEqual([]);
    expect(readRecordedFirings([{ id: "42", entryId: "I10" }])).toEqual([]);
    expect(readRecordedFirings({ recorded: "42" })).toEqual([]);
    expect(readRecordedFirings({})).toEqual([]);
  });
});
