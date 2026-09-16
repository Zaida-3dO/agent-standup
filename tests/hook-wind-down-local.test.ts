// The client's half of the wind-down signal —
// `src/lib/hook/wind-down-local.ts`.
//
// ── Why this half exists at all ────────────────────────────────────────
//
// `idleMs` is the condition that distinguishes the last stop of a session
// from the forty stops before it, and the server cannot measure it:
// `hook_decision` writes nothing per call, `ToolCall.ts` dates the last
// batched flush, and `Session.lastSeenAt` advances only at registration.
// The spool file is the only clock in the system that is both per-session
// and synchronous.
//
// ── Which direction these cases guard ──────────────────────────────────
//
// Every failure must be silence. A signal that answers `undefined` costs a
// missed survey; a signal that answers a wrong number fires the survey
// mid-session, which is the outcome `survey.ts` says is worse than not
// asking at all. So the cases about *not* answering outnumber the ones
// about answering, deliberately.

import { describe, expect, it } from "vitest";
import { idleMsFromSpool, shouldMeasureIdle } from "@/lib/hook/wind-down-local";
import { shouldSurvey, WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";

const NOW = 1_700_000_600_000;

/** One spool line, in the shape `parseRecord` actually requires. */
function record(overrides: { sessionId?: string; ts?: string; tool?: string } = {}): string {
  return JSON.stringify({
    sessionId: overrides.sessionId ?? "s1",
    ts: overrides.ts ?? new Date(NOW).toISOString(),
    tool: overrides.tool ?? "Bash",
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
}

const spool = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("measuring the quiet", () => {
  it("reports the gap since this session's newest record", () => {
    const idle = idleMsFromSpool({
      spoolText: spool(record({ ts: new Date(NOW - 300_000).toISOString() })),
      sessionId: "s1",
      now: NOW,
    });
    expect(idle).toBe(300_000);
  });

  it("takes the newest record, not the last line in the file", () => {
    // The spool is append-only but the flush rewrites it with whatever the
    // server did not acknowledge, so ordering is not guaranteed to survive.
    //
    // Breaks if `at > newest` becomes `at < newest`, which would report the
    // OLDEST call and make a busy session look permanently idle — the exact
    // false positive that fires the survey mid-burst.
    const idle = idleMsFromSpool({
      spoolText: spool(
        record({ ts: new Date(NOW - 60_000).toISOString() }),
        record({ ts: new Date(NOW - 900_000).toISOString() }),
      ),
      sessionId: "s1",
      now: NOW,
    });
    expect(idle).toBe(60_000);
  });

  it("ignores another session's records on the same machine", () => {
    // One machine writes one spool from every session on it, and sessions
    // interleave by default. A busy neighbour would keep the file's newest
    // record perpetually fresh, so reading the tail would report that THIS
    // session had just acted whenever ANY session had — suppressing the
    // survey precisely on the machines that run enough sessions to produce
    // interesting data.
    //
    // Breaks if the `record.sessionId !== sessionId` guard is removed: the
    // neighbour's fresh record would win and the answer would be 0.
    const idle = idleMsFromSpool({
      spoolText: spool(
        record({ sessionId: "s1", ts: new Date(NOW - 400_000).toISOString() }),
        record({ sessionId: "other", ts: new Date(NOW).toISOString() }),
      ),
      sessionId: "s1",
      now: NOW,
    });
    expect(idle).toBe(400_000);
  });
});

describe("every failure is silence", () => {
  it("says nothing when there is no spool yet", () => {
    // The ordinary state of a session that has made no tool calls — and a
    // session that has made no tool calls has tripped no interventions, so
    // there was never anything to survey.
    expect(idleMsFromSpool({ spoolText: undefined, sessionId: "s1", now: NOW })).toBeUndefined();
  });

  it("says nothing when the spool is empty", () => {
    expect(idleMsFromSpool({ spoolText: "", sessionId: "s1", now: NOW })).toBeUndefined();
  });

  it("says nothing when the spool holds no record for this session", () => {
    expect(
      idleMsFromSpool({
        spoolText: spool(record({ sessionId: "other" })),
        sessionId: "s1",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it("says nothing when every line is garbage", () => {
    expect(
      idleMsFromSpool({ spoolText: "not json\nalso not json\n", sessionId: "s1", now: NOW }),
    ).toBeUndefined();
  });

  it("skips a record whose timestamp will not parse", () => {
    // `Date.parse` answers NaN, and NaN compares false against everything —
    // so this would be skipped by the comparison whether or not it were
    // tested for. It is tested for anyway, and this case is what stops the
    // explicit guard being deleted as redundant: without it, reordering the
    // expression later would silently produce `NaN` as an idle time, and
    // `NaN >= WIND_DOWN_QUIET_MS` is false, so the survey would go quiet
    // forever with nothing to show why.
    const idle = idleMsFromSpool({
      spoolText: spool(
        record({ ts: "the day before yesterday" }),
        record({ ts: new Date(NOW - 200_000).toISOString() }),
      ),
      sessionId: "s1",
      now: NOW,
    });
    expect(idle).toBe(200_000);
  });

  it("says nothing when the only record is unparseable", () => {
    expect(
      idleMsFromSpool({
        spoolText: spool(record({ ts: "nonsense" })),
        sessionId: "s1",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it("refuses a future-dated record rather than clamping it to zero", () => {
    // A record dated ahead of the clock means the two disagree — a
    // corrected system clock, a file copied between machines. Clamping to
    // zero would report "this session just acted", which is silence and
    // therefore harmless; but it would report the same thing if the skew
    // were hours, and the next reader could not tell a healthy quiet
    // session from a broken clock.
    //
    // Breaks if `if (idle < 0) return undefined` becomes `Math.max(0, idle)`.
    expect(
      idleMsFromSpool({
        spoolText: spool(record({ ts: new Date(NOW + 60_000).toISOString() })),
        sessionId: "s1",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it("tolerates a torn final line, which an append-only file will have", () => {
    // A hook process killed mid-append leaves half a line. One torn line
    // must not discard the whole measurement.
    const text = `${record({ ts: new Date(NOW - 120_000).toISOString() })}\n{"sessionId":"s1","ts`;
    expect(idleMsFromSpool({ spoolText: text, sessionId: "s1", now: NOW })).toBe(120_000);
  });
});

describe("the cost gate", () => {
  it("measures only on a Stop", () => {
    // A whole-file parse on the critical path of every tool call. The
    // survey discards a non-Stop event on `evaluateStopSurvey`'s first line
    // anyway, so measuring there would be paying the highest-volume path's
    // budget for a number nothing reads.
    expect(shouldMeasureIdle("Stop")).toBe(true);
    expect(shouldMeasureIdle("PreToolUse")).toBe(false);
    expect(shouldMeasureIdle("PostToolUse")).toBe(false);
  });
});

describe("what the measurement decides", () => {
  it("a quiet session passes shouldSurvey; a busy one does not", () => {
    // The two halves joined, against the real predicate rather than a
    // restatement of the threshold. This is the discrimination the brief's
    // second criterion asks to see demonstrated.
    const firings = [{ eventId: "1", entryId: "I10", at: NOW - 500_000 }];

    const quiet = idleMsFromSpool({
      spoolText: spool(record({ ts: new Date(NOW - WIND_DOWN_QUIET_MS - 1).toISOString() })),
      sessionId: "s1",
      now: NOW,
    });
    const busy = idleMsFromSpool({
      spoolText: spool(record({ ts: new Date(NOW - 1_000).toISOString() })),
      sessionId: "s1",
      now: NOW,
    });

    expect(shouldSurvey({ unrated: firings, liveCrew: 0, idleMs: quiet })).toBe(true);
    expect(shouldSurvey({ unrated: firings, liveCrew: 0, idleMs: busy })).toBe(false);
  });
});
