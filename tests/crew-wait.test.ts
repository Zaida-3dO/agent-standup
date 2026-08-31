// Wait-for-crew — MILESTONES.md #64, DECISIONS.md §6, SCHEMA.md §19.
//
// Two things are proved here, and the second is the one the row is really
// about:
//
//   1. The wait is **bounded** — it returns at its deadline and not after,
//      and it returns early when there is something to say.
//   2. Both implementations **return identically**. That is asserted
//      directly, by running the same ledger through both strategies and
//      deep-comparing the results, rather than by inspecting two code paths
//      and believing they agree.
//
// **Why (2) is what keeps an open decision open.** MILESTONES.md still
// carries *"Does Codex need the blocking wait-for-crew fallback?"* as
// unanswered. As long as the two doors provably return the same thing,
// answering it either way is a change of which door a client is offered and
// nothing else — no behaviour here moves. The moment they could diverge,
// the decision would silently become load-bearing.
//
// The clock is virtual throughout. A wait's contract is about *when* it
// returns, and testing that against a real clock is either slow or flaky;
// with an injected clock the boundary is exact, which is what lets the
// "times out exactly at the deadline" and "satisfied one tick before it"
// cases be distinguished at all.
import { describe, expect, it } from "vitest";
import {
  clampWaitMs,
  crewSlice,
  holdingStrategy,
  isCrewEvent,
  pollingStrategy,
  waitForCrew,
  type WaitClock,
} from "@/lib/crew/wait-core";
import type { TransactionHandle } from "@/lib/service/context";

/**
 * A ledger stub standing in for `readSinceBounded`'s query.
 *
 * **It implements the horizon bound, not just the cursor.** Rows carry a
 * `txId` and a `committed` flag, and the stub withholds anything at or above
 * the horizon exactly as the real read does. A stub that returned everything
 * with `id > since` would let a wait pass tests it would fail against
 * Postgres — the skipped-row failure §3 describes is invisible without it.
 */
interface StubRow {
  id: bigint;
  txId: bigint;
  type: string;
}

function ledger(rows: StubRow[], horizon = 1_000n): TransactionHandle {
  return {
    async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
      if (query.includes("pg_snapshot_xmin")) {
        return [{ horizon }] as T;
      }
      const since = values[0] as bigint;
      const bound = values[1] as bigint;
      const limit = values[2] as number;
      const selected = rows
        .filter((row) => row.id > since && row.txId < bound)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          txId: row.txId,
          itemId: null,
          ts: new Date(0),
          actorType: "agent",
          actorId: null,
          sessionId: null,
          assignmentId: null,
          type: row.type,
        }));
      return selected as T;
    },
    async $executeRawUnsafe(): Promise<number> {
      return 0;
    },
  };
}

/** A clock the test drives by hand. `sleep` advances it rather than waiting. */
function virtualClock(): WaitClock & { elapsed: () => number; sleeps: () => number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    async sleep(ms: number) {
      slept.push(ms);
      t += ms;
    },
    elapsed: () => t,
    sleeps: () => slept,
  };
}

const CHECKPOINT = (id: bigint, txId = 1n): StubRow => ({ id, txId, type: "checkpoint" });
const SETTING = (id: bigint, txId = 1n): StubRow => ({ id, txId, type: "setting_change" });

describe("isCrewEvent (#64)", () => {
  // Kills: filtering nothing (returning true for everything), which would
  // wake an orchestrator for a settings edit — the noise §6's design
  // explicitly avoids.
  it("counts crew activity and not bookkeeping", () => {
    expect(isCrewEvent("checkpoint")).toBe(true);
    expect(isCrewEvent("claim")).toBe(true);
    expect(isCrewEvent("state_change")).toBe(true);
    expect(isCrewEvent("setting_change")).toBe(false);
    expect(isCrewEvent("field_change")).toBe(false);
  });
});

describe("clampWaitMs (#64)", () => {
  // Kills: dropping the clamp — §19 says `timeout` "is clamped to
  // crew.wait_timeout_seconds", and an unclamped wait can outlive the
  // prompt cache the setting is sized against.
  it("clamps a request longer than the configured maximum", () => {
    expect(clampWaitMs(600, 240)).toBe(240_000);
  });

  // Kills: clamping in the wrong direction (forcing every wait to the max).
  it("honours a request shorter than the maximum", () => {
    expect(clampWaitMs(30, 240)).toBe(30_000);
  });

  // Kills: defaulting to something other than the setting.
  it("uses the configured maximum when nothing is requested", () => {
    expect(clampWaitMs(undefined, 240)).toBe(240_000);
  });

  // Kills: letting a negative through, which would make `budgetMs` negative
  // and the deadline already past in a way that reads as a bug rather than
  // as "check now".
  it("floors a zero or negative request at an immediate check", () => {
    expect(clampWaitMs(0, 240)).toBe(0);
    expect(clampWaitMs(-5, 240)).toBe(0);
  });
});

describe("crewSlice (#64)", () => {
  // Kills: dropping the `txId < horizon` bound. THE property §3 and §19
  // both insist on: id 5 committed late, below the horizon-holding writer,
  // must be withheld rather than stepped over. Without the bound this
  // returns it now and the caller's cursor advances past id 7, so id 5 is
  // never seen again.
  it("withholds an event whose writing transaction has not finished", async () => {
    const db = ledger([CHECKPOINT(5n, 900n), CHECKPOINT(7n, 50n)], 800n);

    const slice = await crewSlice(db, 0n);

    expect(slice.events.map((e) => e.id)).toEqual([7n]);
    expect(slice.horizon).toBe("800");
  });

  // Kills: advancing the cursor only over crew events. A ledger full of
  // non-crew rows would then re-read the same rows on every pass forever,
  // and a wait would never make progress.
  it("advances the cursor past events it filtered out", async () => {
    const db = ledger([SETTING(3n), SETTING(4n)]);

    const slice = await crewSlice(db, 0n);

    expect(slice.events).toEqual([]);
    expect(slice.cursor).toBe("4");
  });

  // Kills: returning the caller's cursor unchanged, or resetting it to 0.
  it("returns the high-water mark of what it read", async () => {
    const db = ledger([CHECKPOINT(9n)]);
    expect((await crewSlice(db, 0n)).cursor).toBe("9");
  });

  // Kills: an empty read rewinding the cursor to zero, which would replay
  // the whole ledger.
  it("holds the cursor still when there is nothing to read", async () => {
    const db = ledger([]);
    expect((await crewSlice(db, 42n)).cursor).toBe("42");
  });
});

describe("waitForCrew — bounds (#64)", () => {
  // Kills: sleeping before the first read. A caller handed a cursor and
  // asking again is the common case and must not pay a poll interval for it.
  it("returns immediately when events are already outstanding", async () => {
    const clock = virtualClock();
    const db = ledger([CHECKPOINT(1n)]);

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 240_000,
      strategy: pollingStrategy(5),
      clock,
    });

    expect(result.timedOut).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(clock.elapsed()).toBe(0);
  });

  // Kills: `remaining <= 0` mutated to `< 0`, and any off-by-one in the
  // deadline. THE boundary case the brief names: a wait that times out
  // exactly at the horizon. With a 10s budget and a 5s interval, the two
  // sleeps land exactly on the deadline and the wait must end there rather
  // than sleeping a third time.
  it("times out exactly at the deadline, not past it", async () => {
    const clock = virtualClock();
    const db = ledger([]);

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 10_000,
      strategy: pollingStrategy(5),
      clock,
    });

    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
    expect(clock.elapsed()).toBe(10_000);
    expect(clock.sleeps()).toEqual([5_000, 5_000]);
  });

  // Kills: a strategy that overruns the deadline. The last pause must be
  // trimmed to what is left, or the polling door returns later than the
  // held-open one and the identity below is false in the timing dimension.
  it("never sleeps past the deadline", async () => {
    const clock = virtualClock();
    const db = ledger([]);

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 7_000,
      strategy: pollingStrategy(5),
      clock,
    });

    expect(result.timedOut).toBe(true);
    expect(clock.elapsed()).toBe(7_000);
    expect(clock.sleeps()).toEqual([5_000, 2_000]);
  });

  // Kills: returning `timedOut: true` whenever the loop went round at least
  // once. The other half of the boundary the brief names — a wait satisfied
  // one tick BEFORE the deadline is not a timeout.
  it("returns satisfied when an event lands one tick before the deadline", async () => {
    const clock = virtualClock();
    const rows: StubRow[] = [];
    const db = ledger(rows);
    // The event appears during the first pause — one interval before the
    // 10s deadline.
    const strategy = {
      async pause(budgetMs: number, c: WaitClock) {
        await c.sleep(Math.min(5_000, budgetMs));
        rows.push(CHECKPOINT(1n));
      },
    };

    const result = await waitForCrew(db, { since: 0n, budgetMs: 10_000, strategy, clock });

    expect(result.timedOut).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(clock.elapsed()).toBe(5_000);
  });

  // Kills: an immediate-check request being treated as an unbounded wait.
  it("reads once and returns when the budget is zero", async () => {
    const clock = virtualClock();
    const db = ledger([]);

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 0,
      strategy: pollingStrategy(5),
      clock,
    });

    expect(result.timedOut).toBe(true);
    expect(clock.sleeps()).toEqual([]);
  });

  // The termination backstop, added after mutation testing found that
  // `remaining <= 0` mutated to `< 0` does not make this wait return late —
  // it makes it never return at all, spinning on a zero-length sleep. A
  // wait whose entire contract is that it ends should not be one comparison
  // away from unbounded.
  //
  // Kills: deleting the `clock.now() <= before` backstop. A strategy that
  // does not advance the clock must end the wait rather than loop forever;
  // without the backstop this test hangs instead of failing.
  it("ends rather than spinning when a pause does not advance the clock", async () => {
    const clock = virtualClock();
    const db = ledger([]);
    // A strategy that never advances time — the shape a clamped sleep takes
    // once the remaining budget has reached zero.
    const stuck = { async pause() {} };

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 10_000,
      strategy: stuck,
      clock,
    });

    expect(result.timedOut).toBe(true);
  });

  // Kills: waking on any ledger row rather than on crew activity — the wait
  // would return "empty but satisfied", which is the worst of both.
  it("keeps waiting through non-crew events and times out", async () => {
    const clock = virtualClock();
    const db = ledger([SETTING(1n), SETTING(2n)]);

    const result = await waitForCrew(db, {
      since: 0n,
      budgetMs: 10_000,
      strategy: pollingStrategy(5),
      clock,
    });

    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
    // The cursor still moved past them.
    expect(result.cursor).toBe("2");
  });
});

describe("waitForCrew — the two doors return identically (#64)", () => {
  /**
   * The row's own words: *"both bounded by the visibility horizon and
   * returning identically"*, and *"the implementation follows the binding,
   * never the caller"*.
   *
   * **This is the assertion that keeps the open decision open.** While the
   * two doors provably answer the same thing, whether Codex is offered the
   * blocking one is a question about which door a client gets — not a
   * question about behaviour. Nothing in this file answers it, and nothing
   * needs to.
   */
  function bothDoors(rows: StubRow[], horizon?: number) {
    const h = horizon === undefined ? undefined : BigInt(horizon);
    return {
      polling: () => ledger([...rows], h),
      // The held-open door, whose signal never fires — the degenerate case
      // that must still match, because a held connection with a quiet
      // ledger is exactly a timeout.
      holdingQuiet: () => ledger([...rows], h),
    };
  }

  it("agree when there is something to return", async () => {
    const rows = [CHECKPOINT(1n), SETTING(2n), CHECKPOINT(3n)];
    const doors = bothDoors(rows);

    const polled = await waitForCrew(doors.polling(), {
      since: 0n,
      budgetMs: 10_000,
      strategy: pollingStrategy(5),
      clock: virtualClock(),
    });
    const held = await waitForCrew(doors.holdingQuiet(), {
      since: 0n,
      budgetMs: 10_000,
      strategy: holdingStrategy(() => Promise.resolve()),
      clock: virtualClock(),
    });

    expect(held).toEqual(polled);
  });

  it("agree when the ledger is quiet and both time out", async () => {
    const doors = bothDoors([SETTING(1n)]);

    const polled = await waitForCrew(doors.polling(), {
      since: 0n,
      budgetMs: 10_000,
      strategy: pollingStrategy(5),
      clock: virtualClock(),
    });
    const held = await waitForCrew(doors.holdingQuiet(), {
      since: 0n,
      budgetMs: 10_000,
      // A signal that never resolves — the connection is simply held.
      strategy: holdingStrategy(() => new Promise<void>(() => {})),
      clock: virtualClock(),
    });

    expect(held).toEqual(polled);
    expect(held.timedOut).toBe(true);
  });

  it("agree on what the horizon withholds", async () => {
    const rows = [CHECKPOINT(5n, 900n), CHECKPOINT(7n, 50n)];
    const doors = bothDoors(rows, 800);

    const polled = await waitForCrew(doors.polling(), {
      since: 0n,
      budgetMs: 10_000,
      strategy: pollingStrategy(5),
      clock: virtualClock(),
    });
    const held = await waitForCrew(doors.holdingQuiet(), {
      since: 0n,
      budgetMs: 10_000,
      strategy: holdingStrategy(() => Promise.resolve()),
      clock: virtualClock(),
    });

    expect(held).toEqual(polled);
    expect(polled.events.map((e) => e.id)).toEqual([7n]);
  });

  // Kills: a strategy that contributes to the ANSWER rather than only to
  // the pause. If a door could filter, bound or shape the result, this
  // would diverge — and the open decision would quietly become
  // load-bearing.
  it("agree across a range of ledgers and budgets", async () => {
    const cases: { rows: StubRow[]; budgetMs: number }[] = [
      { rows: [], budgetMs: 0 },
      { rows: [], budgetMs: 10_000 },
      { rows: [CHECKPOINT(1n)], budgetMs: 0 },
      { rows: [SETTING(1n), SETTING(2n), CHECKPOINT(3n)], budgetMs: 10_000 },
      { rows: [CHECKPOINT(2n, 999n)], budgetMs: 5_000 },
    ];

    for (const { rows, budgetMs } of cases) {
      const polled = await waitForCrew(ledger([...rows]), {
        since: 0n,
        budgetMs,
        strategy: pollingStrategy(5),
        clock: virtualClock(),
      });
      const held = await waitForCrew(ledger([...rows]), {
        since: 0n,
        budgetMs,
        strategy: holdingStrategy(() => Promise.resolve()),
        clock: virtualClock(),
      });
      expect(held).toEqual(polled);
    }
  });
});
