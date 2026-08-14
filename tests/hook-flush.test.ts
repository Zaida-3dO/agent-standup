// MILESTONES.md #88 — the batched flush (`src/lib/hook/flush.ts`).
//
// **The rule every test here is really about: nothing leaves the spool
// until the server has said it took it.** §10's facet and cost history
// "cannot be backfilled", so a record dropped here is one nobody can ever
// recover — which makes the interesting cases the failures, not the
// successes. A flush that deletes on send rather than on acknowledgement
// passes a happy-path suite perfectly and loses data on exactly the failure
// it most needs to survive: a server that accepted the connection and then
// fell over.
//
// The deliberate cost of that rule is duplication — a batch stored but not
// acknowledged is sent again — and it is asserted below rather than merely
// documented, because "at-least-once" is a promise the ingest (#50) builds
// its de-duplication on. A later change that made this exactly-once by
// dropping on send would be strictly worse and would break no test unless
// one pins it.
import { describe, expect, it } from "vitest";
import { flushSpool, toWireCall, type SendBatch, type ToolCallBatch } from "@/lib/hook/flush";
import { readSpool, serialiseRecord } from "@/lib/hook/spool";
import type { SpooledToolCall } from "@/lib/hook/spool-record";

function record(tool: string, sessionId = "session-a"): SpooledToolCall {
  return {
    sessionId,
    ts: "2026-01-01T00:00:00.000Z",
    tool,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}

function spoolOf(tools: readonly string[]): string {
  return tools.map((tool) => serialiseRecord(record(tool))).join("");
}

/** A `send` that records what it was given and answers as scripted. */
function recorder(answers: readonly boolean[]): {
  send: SendBatch;
  seen: ToolCallBatch[];
} {
  const seen: ToolCallBatch[] = [];
  let call = 0;
  const send: SendBatch = async (batch) => {
    seen.push({ sessionId: batch.sessionId, calls: [...batch.calls] });
    const answer = answers[call] ?? true;
    call += 1;
    return answer;
  };
  return { send, seen };
}

/** The tool names in one sent batch, in order. */
function toolsOf(batch: ToolCallBatch | undefined): readonly string[] {
  return (batch?.calls ?? []).map((one) => one.tool);
}

describe("the wire shape matches what the ingest accepts", () => {
  // The ingest validates strictly: an unrecognised key is a rejected
  // request, not an ignored field. So these are not stylistic assertions —
  // each one is a field that would fail every flush forever if it were sent.

  it("puts sessionId on the envelope and never on a call", async () => {
    const { send, seen } = recorder([]);
    await flushSpool({ spoolText: spoolOf(["a"]), send });

    expect(seen[0]?.sessionId).toBe("session-a");
    expect(seen[0]?.calls[0]).not.toHaveProperty("sessionId");
  });

  it("drops model and effort, which have no receiver until the runs row", async () => {
    // Kept on the spool and withheld from the wire. Sending them would fail
    // the whole batch; dropping them from the *capture* would mean the runs
    // row starts with no history, which is the half that cannot be
    // backfilled.
    const spooled: SpooledToolCall = {
      ...record("Bash"),
      model: "vendor-model-1",
      effort: "high",
    };
    const { send, seen } = recorder([]);
    await flushSpool({ spoolText: serialiseRecord(spooled), send });

    expect(seen[0]?.calls[0]).not.toHaveProperty("model");
    expect(seen[0]?.calls[0]).not.toHaveProperty("effort");
  });

  it("sends exactly the keys the ingest names, and no others", async () => {
    // The strongest form: an allow-list assertion rather than three
    // individual denials, so a field added to the spool later cannot reach
    // the wire unnoticed.
    const spooled: SpooledToolCall = {
      ...record("Bash"),
      command: "git status",
      paths: ["src/a.ts"],
      model: "vendor-model-1",
      effort: "high",
      usage5h: 12.5,
      usageWeekly: 44,
    };
    const { send, seen } = recorder([]);
    await flushSpool({ spoolText: serialiseRecord(spooled), send });

    expect(Object.keys(seen[0]?.calls[0] ?? {}).sort()).toEqual([
      "cacheReadTokens",
      "cacheWriteTokens",
      "command",
      "inputTokens",
      "outputTokens",
      "paths",
      "tool",
      "ts",
      "usage5h",
      "usageWeekly",
    ]);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["calls", "sessionId"]);
  });

  it("carries the values through unchanged", async () => {
    // The negative assertions above would all pass on a `toWireCall` that
    // returned an empty object, so the values are pinned too.
    const spooled: SpooledToolCall = {
      ...record("Bash"),
      command: "git status",
      paths: ["src/a.ts"],
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 30,
      cacheReadTokens: 40,
      usage5h: 12.5,
    };
    expect(toWireCall(spooled)).toEqual({
      tool: "Bash",
      ts: "2026-01-01T00:00:00.000Z",
      command: "git status",
      paths: ["src/a.ts"],
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 30,
      cacheReadTokens: 40,
      usage5h: 12.5,
    });
  });

  it("omits absent optional fields rather than sending them as undefined", async () => {
    // `JSON.stringify` drops an explicit `undefined`, so this would survive
    // the wire either way — but the schema is strict about *keys*, and a
    // key whose value is null is a different thing from an absent one.
    expect(Object.keys(toWireCall(record("Read"))).sort()).toEqual([
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputTokens",
      "outputTokens",
      "tool",
      "ts",
    ]);
  });
});

describe("records are grouped by session, because the envelope names one", () => {
  it("sends one request per session", async () => {
    const text = [record("a", "session-a"), record("b", "session-b"), record("c", "session-a")]
      .map(serialiseRecord)
      .join("");

    const { send, seen } = recorder([]);
    const result = await flushSpool({ spoolText: text, send });

    expect(result.sent).toBe(3);
    expect(seen.length).toBe(2);
    expect(seen.map((batch) => batch.sessionId)).toEqual(["session-a", "session-b"]);
    // Order within a session is preserved — it is the order the calls
    // happened, which is what the runs row reconstructs from.
    expect(toolsOf(seen[0])).toEqual(["a", "c"]);
    expect(toolsOf(seen[1])).toEqual(["b"]);
  });

  it("never mixes two sessions into one request", async () => {
    // The failure this grouping exists to prevent: a batch spanning two
    // sessions has no correct `sessionId`, so one session's calls would be
    // attributed to the other.
    const text = Array.from({ length: 6 }, (_, index) =>
      record(`t${index}`, index % 2 === 0 ? "session-a" : "session-b"),
    )
      .map(serialiseRecord)
      .join("");

    const { send, seen } = recorder([]);
    await flushSpool({ spoolText: text, send, batchSize: 2 });

    for (const batch of seen) {
      expect(batch.calls.length).toBeGreaterThan(0);
    }
    expect(
      seen.every((batch) => batch.sessionId === "session-a" || batch.sessionId === "session-b"),
    ).toBe(true);
  });

  it("retains a failed session's records while keeping an accepted one's gone", async () => {
    // Why retention is tracked by identity rather than by position: a
    // later session can succeed while an earlier one fails, so "the first N
    // records" describes something other than what landed. Counting would
    // delete this failed session's records because a different session
    // happened to succeed.
    const text = [record("a", "session-a"), record("b", "session-b")].map(serialiseRecord).join("");

    // Refuse session-a, accept session-b.
    const send: SendBatch = async (batch) => batch.sessionId !== "session-a";
    const result = await flushSpool({ spoolText: text, send });

    expect(result.sent).toBe(1);
    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual(["a"]);
  });

  it("keeps the spool's original order in what it retains", async () => {
    // Retention is filtered from the original list rather than rebuilt from
    // the groups, so a file flushed repeatedly is not progressively
    // reordered by its own retries.
    const text = [
      record("a", "session-a"),
      record("b", "session-b"),
      record("c", "session-a"),
      record("d", "session-b"),
    ]
      .map(serialiseRecord)
      .join("");

    const send: SendBatch = async () => false;
    const result = await flushSpool({ spoolText: text, send });

    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("a flush that succeeds empties the spool", () => {
  it("sends everything and leaves nothing behind", async () => {
    const { send, seen } = recorder([]);
    const result = await flushSpool({ spoolText: spoolOf(["a", "b", "c"]), send, batchSize: 2 });

    expect(result.sent).toBe(3);
    expect(result.retained).toBe(0);
    expect(result.remaining).toBe("");
    expect(result.stoppedEarly).toBe(false);
    expect(seen.map(toolsOf)).toEqual([["a", "b"], ["c"]]);
  });

  it("does nothing, successfully, on an empty spool", async () => {
    const { send, seen } = recorder([]);
    const result = await flushSpool({ send });
    expect(result).toMatchObject({ sent: 0, retained: 0, attempted: 0, stoppedEarly: false });
    expect(seen).toEqual([]);
  });
});

describe("nothing leaves the spool until the server takes it", () => {
  it("retains the failed batch and everything after it", async () => {
    // The central property. `a`/`b` were acknowledged and are gone; `c`/`d`
    // failed and `e` was never attempted, and both stay.
    const { send, seen } = recorder([true, false]);
    const result = await flushSpool({
      spoolText: spoolOf(["a", "b", "c", "d", "e"]),
      send,
      batchSize: 2,
    });

    expect(result.sent).toBe(2);
    expect(result.retained).toBe(3);
    expect(result.stoppedEarly).toBe(true);
    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual(["c", "d", "e"]);
    // Stopped rather than continuing: the third batch was never sent.
    expect(seen.length).toBe(2);
  });

  it("retains everything when the very first batch fails", async () => {
    const { send } = recorder([false]);
    const result = await flushSpool({ spoolText: spoolOf(["a", "b"]), send, batchSize: 5 });
    expect(result.sent).toBe(0);
    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual(["a", "b"]);
  });

  it("treats a send that throws exactly as one that refused", async () => {
    // A flush that propagated an exception would take down whatever called
    // it — and the whole point of spooling is that telemetry cannot affect
    // the thing it measures.
    const send: SendBatch = async () => {
      throw new Error("connection reset");
    };
    const result = await flushSpool({ spoolText: spoolOf(["a"]), send });
    expect(result.sent).toBe(0);
    expect(result.stoppedEarly).toBe(true);
    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual(["a"]);
  });

  it("preserves order in what it retains", async () => {
    // Retention is a contiguous run from the failure onwards, in the order
    // the calls happened. A retry that reordered would scramble the
    // sequence the ingest reconstructs runs from.
    const { send } = recorder([false]);
    const result = await flushSpool({
      spoolText: spoolOf(["a", "b", "c", "d"]),
      send,
      batchSize: 1,
    });
    expect(readSpool(result.remaining).records.map((one) => one.tool)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("re-sends a retained batch on the next flush, which is at-least-once by design", async () => {
    // The stated cost of the rule above, pinned so that "fixing" it into
    // exactly-once by dropping on send would fail here rather than silently
    // losing telemetry.
    const first = recorder([false]);
    const failed = await flushSpool({ spoolText: spoolOf(["a"]), send: first.send });

    const second = recorder([true]);
    const retried = await flushSpool({ spoolText: failed.remaining, send: second.send });

    expect(toolsOf(second.seen[0])).toEqual(["a"]);
    expect(retried.sent).toBe(1);
    expect(retried.remaining).toBe("");
  });
});

describe("unreadable lines are dropped rather than retried forever", () => {
  it("counts them, sends the readable ones, and does not keep them", async () => {
    // A line that cannot be parsed cannot be sent, so retaining it means
    // re-skipping it on every flush for the life of the machine.
    const { send, seen } = recorder([]);
    const text = `${serialiseRecord(record("a"))}garbage\n${serialiseRecord(record("b"))}`;
    const result = await flushSpool({ spoolText: text, send });

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(2);
    expect(result.remaining).toBe("");
    expect(toolsOf(seen[0])).toEqual(["a", "b"]);
  });

  it("reports a spool of pure garbage as skipped with nothing sent", async () => {
    const { send, seen } = recorder([]);
    const result = await flushSpool({ spoolText: "nope\nalso nope\n", send });
    expect(result).toMatchObject({ sent: 0, skipped: 2, retained: 0, attempted: 0 });
    expect(seen).toEqual([]);
  });
});

describe("the ceiling is enforced on the read path too", () => {
  it("drops the oldest and reports it rather than sending an unbounded backlog", async () => {
    // Reachable without any single append having exceeded the ceiling: a
    // build with a larger one wrote the file, or the setting was lowered.
    const { send, seen } = recorder([]);
    const result = await flushSpool({
      spoolText: spoolOf(["a", "b", "c", "d"]),
      send,
      maxRecords: 2,
    });

    expect(result.dropped).toBe(2);
    expect(result.sent).toBe(2);
    expect(toolsOf(seen[0])).toEqual(["c", "d"]);
  });
});
