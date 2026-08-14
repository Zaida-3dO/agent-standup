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
import { flushSpool, type SendBatch } from "@/lib/hook/flush";
import { readSpool, serialiseRecord } from "@/lib/hook/spool";
import type { SpooledToolCall } from "@/lib/hook/spool-record";

function record(tool: string): SpooledToolCall {
  return {
    sessionId: "session-a",
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
  seen: SpooledToolCall[][];
} {
  const seen: SpooledToolCall[][] = [];
  let call = 0;
  const send: SendBatch = async (batch) => {
    seen.push([...batch]);
    const answer = answers[call] ?? true;
    call += 1;
    return answer;
  };
  return { send, seen };
}

describe("a flush that succeeds empties the spool", () => {
  it("sends everything and leaves nothing behind", async () => {
    const { send, seen } = recorder([]);
    const result = await flushSpool({ spoolText: spoolOf(["a", "b", "c"]), send, batchSize: 2 });

    expect(result.sent).toBe(3);
    expect(result.retained).toBe(0);
    expect(result.remaining).toBe("");
    expect(result.stoppedEarly).toBe(false);
    expect(seen.map((batch) => batch.map((one) => one.tool))).toEqual([["a", "b"], ["c"]]);
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

    expect(second.seen[0]?.map((one) => one.tool)).toEqual(["a"]);
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
    expect(seen[0]?.map((one) => one.tool)).toEqual(["a", "b"]);
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
    expect(seen[0]?.map((one) => one.tool)).toEqual(["c", "d"]);
  });
});
