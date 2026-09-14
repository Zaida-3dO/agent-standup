// `standup crew wait` — the CLI verb and the operation behind it
// (MILESTONES.md #64, SCHEMA.md §18/§19/§20).
//
// The wait's *core* is already covered by `crew-wait.test.ts`, which proves
// the loop, the bound and the two doors' identity. Nothing here re-tests any
// of that. What this file covers is the wiring that did not exist — the verb,
// the input it builds, the route it reaches, the settings it resolves, and
// the MCP waiver that keeps it off a surface that cannot serve it.
//
// Needs no database: the command half is a pure function of words and flags,
// and the operation half is driven with a fake transaction handle and a
// virtual clock, the same way `crew-wait.test.ts` drives the core.
import { describe, expect, it } from "vitest";
import { COMMANDS, HTTP_ROUTES, lookupCommand } from "@/lib/cli";
import { isWaived, waiverFor } from "@/lib/adapters/waivers";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { runWaitForCrew, type WaitForCrewOutput } from "@/lib/service/operations/wait-for-crew";
import type { ServiceContext, TransactionHandle } from "@/lib/service/context";
import type { WaitClock } from "@/lib/crew/wait-core";

function commandFor(noun: string, verb: string) {
  const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!command) throw new Error(`no such command: ${noun} ${verb}`);
  return command;
}

describe("standup crew wait — the verb", () => {
  const wait = commandFor("crew", "wait");

  it("calls the wait_for_crew operation", () => {
    expect(wait.operation).toBe("wait_for_crew");
  });

  it("refuses with no --since, naming the flag", () => {
    const built = wait.buildInput([], {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["since"]);
    // The message has to say where a cursor comes from — someone running
    // this for the first time has no idea what to put there.
    expect(built.envelope.error.message).toMatch(/orientation/);
  });

  it("builds the minimal call from --since alone", () => {
    const built = wait.buildInput([], { since: "42" });
    expect(built).toEqual({ ok: true, input: { since: "42" } });
  });

  it("keeps --since a string, so a bigint cursor cannot lose precision", () => {
    // Past 2^53 a JSON number rounds. `9007199254740993` is 2^53+1, which is
    // not representable as a double: if this ever arrives as a number it
    // comes back as ...992 and the cursor silently skips or repeats a row.
    const built = wait.buildInput([], { since: "9007199254740993" });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    const input = built.input as { since: unknown };
    expect(typeof input.since).toBe("string");
    expect(input.since).toBe("9007199254740993");
  });

  it("converts --timeout and --limit to numbers, because the schema takes numbers", () => {
    const built = wait.buildInput([], { since: "0", timeout: "30", limit: "10" });
    expect(built).toEqual({ ok: true, input: { since: "0", timeout: 30, limit: 10 } });
  });

  it("refuses a non-numeric --timeout by name rather than passing it through", () => {
    const built = wait.buildInput([], { since: "0", timeout: "soon" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["timeout"]);
  });

  it("omits timeout and limit entirely when not given, rather than sending undefined", () => {
    // The operation defaults `limit` and treats an absent `timeout` as "the
    // configured maximum". Sending the keys with `undefined` would put them
    // in the query string as the string "undefined" on the http binding.
    const built = wait.buildInput([], { since: "7" });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(Object.keys(built.input as object)).toEqual(["since"]);
  });

  it("is reachable by the words a user types", () => {
    const found = lookupCommand(["crew", "wait"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("wait_for_crew");
  });

  it("tells the reader to background it — the whole reason this is a shell call", () => {
    expect(wait.summary).toMatch(/[Bb]ackground/);
  });
});

describe("the http binding can reach the wait", () => {
  it("routes wait_for_crew to GET /api/crew/wait with everything in the query string", () => {
    const route = HTTP_ROUTES.wait_for_crew;
    expect(route).toBeDefined();
    expect(route?.method).toBe("GET");
    const built = route?.request({ since: "42", timeout: 30 });
    expect(built?.path).toBe("/api/crew/wait?since=42&timeout=30");
    // A GET carries no body; a body here would be silently dropped by fetch.
    expect(built?.body).toBeUndefined();
  });

  it("returns the operation's result object unwrapped, as direct does", () => {
    const body = { events: [], cursor: "9", horizon: "10", timedOut: true };
    expect(HTTP_ROUTES.wait_for_crew?.unwrap(body)).toEqual(body);
  });
});

describe("wait_for_crew is registered and kept off MCP deliberately", () => {
  it("is a registered read operation", () => {
    const operation = OPERATION_REGISTRY.wait_for_crew;
    expect(operation).toBeDefined();
    expect(operation.kind).toBe("read");
  });

  it("is waived on both MCP transports, with a reason that names the alternative", () => {
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      expect(isWaived(adapter, "wait_for_crew")).toBe(true);
      const waiver = waiverFor(adapter, "wait_for_crew");
      // A stranded agent that calls the tool is shown this reason, so it has
      // to name the door that does work.
      expect(waiver?.reason).toMatch(/standup crew wait|command line/);
    }
  });
});

// ── The operation half ─────────────────────────────────────────────────
//
// Driven with a fake ledger and a virtual clock, so the clamp and the
// strategy are asserted exactly rather than by waiting in real time.

interface FakeRow {
  id: bigint;
  txId: bigint;
  itemId: string | null;
  ts: Date;
  actorType: string;
  actorId: string | null;
  sessionId: string | null;
  assignmentId: string | null;
  type: string;
}

function row(id: number, type: string): FakeRow {
  return {
    id: BigInt(id),
    txId: BigInt(id),
    itemId: "item-1",
    ts: new Date("2026-09-14T00:00:00.000Z"),
    actorType: "agent",
    actorId: "agent-1",
    sessionId: "session-1",
    assignmentId: null,
    type,
  };
}

/**
 * A transaction handle that answers the ledger read and the horizon probe.
 *
 * `readSinceBounded` issues the horizon query and the row query; both arrive
 * here as raw SQL, so they are told apart by what they select rather than by
 * a mock framework.
 */
function ledger(rows: readonly FakeRow[], onRead?: () => void): TransactionHandle {
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      if (/txid_snapshot|pg_snapshot|horizon/i.test(query)) {
        return [{ horizon: 1_000n }] as T;
      }
      onRead?.();
      const since = (values[0] ?? 0n) as bigint;
      return rows.filter((r) => r.id > since) as T;
    },
    async $executeRawUnsafe(): Promise<number> {
      return 0;
    },
  };
}

function contextFor(db: TransactionHandle, maxSeconds: number, interval: number): ServiceContext {
  return {
    db,
    settings: {
      values: {
        "crew.wait_timeout_seconds": maxSeconds,
        "crew.wait_poll_interval_seconds": interval,
      },
    } as unknown as ServiceContext["settings"],
    caller: {},
    operation: "wait_for_crew",
  };
}

/** A clock whose time only moves when something sleeps on it. */
function virtualClock(): WaitClock & { elapsed(): number } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    elapsed: () => now,
  };
}

describe("wait_for_crew — the operation", () => {
  it("returns crew events as soon as there are any, without waiting", async () => {
    const clock = virtualClock();
    const result = await runWaitForCrew(
      contextFor(ledger([row(5, "checkpoint")]), 240, 5),
      { since: "0", limit: 50 },
      { clock },
    );
    expect(result.timedOut).toBe(false);
    expect(result.events.map((e) => e.type)).toEqual(["checkpoint"]);
    expect(result.cursor).toBe("5");
    // It answered on the first read, so nothing slept.
    expect(clock.elapsed()).toBe(0);
  });

  it("times out empty when the ledger only ever holds non-crew events", async () => {
    const clock = virtualClock();
    const result = await runWaitForCrew(
      contextFor(ledger([row(5, "field_change")]), 60, 5),
      { since: "0", limit: 50 },
      { clock },
    );
    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
    // The cursor still advanced past the row it did not report, so the next
    // call does not re-read it forever.
    expect(result.cursor).toBe("5");
    expect(clock.elapsed()).toBe(60_000);
  });

  it("clamps a timeout above the configured maximum instead of refusing it", async () => {
    const clock = virtualClock();
    const result = await runWaitForCrew(
      contextFor(ledger([]), 240, 5),
      { since: "0", timeout: 99_999, limit: 50 },
      { clock },
    );
    // §19: "`timeout` is clamped to `crew.wait_timeout_seconds`".
    expect(result.waitedForSeconds).toBe(240);
    expect(clock.elapsed()).toBe(240_000);
  });

  it("honours a timeout below the maximum", async () => {
    const clock = virtualClock();
    const result = await runWaitForCrew(
      contextFor(ledger([]), 240, 5),
      { since: "0", timeout: 20, limit: 50 },
      { clock },
    );
    expect(result.waitedForSeconds).toBe(20);
    expect(clock.elapsed()).toBe(20_000);
  });

  it("actually uses crew.wait_poll_interval_seconds to space its reads", async () => {
    // This is the assertion that would have caught the original defect: the
    // setting was declared, documented and rendered on the settings page,
    // and nothing read it. A 60s budget on a 5s interval is 12 sleeps and
    // 13 reads; changing the interval changes the read count, so the setting
    // is proven to reach behaviour rather than merely to be resolved.
    const clock = virtualClock();
    let reads = 0;
    await runWaitForCrew(
      contextFor(
        ledger([], () => {
          reads += 1;
        }),
        60,
        5,
      ),
      { since: "0", limit: 50 },
      { clock },
    );
    expect(reads).toBe(13);

    const slower = virtualClock();
    let slowerReads = 0;
    await runWaitForCrew(
      contextFor(
        ledger([], () => {
          slowerReads += 1;
        }),
        60,
        20,
      ),
      { since: "0", limit: 50 },
      { clock: slower },
    );
    expect(slowerReads).toBe(4);
  });

  it("reports the horizon so a caller can tell a short delay from a stuck one", async () => {
    const result: WaitForCrewOutput = await runWaitForCrew(
      contextFor(ledger([row(2, "claim")]), 240, 5),
      { since: "0", limit: 50 },
      { clock: virtualClock() },
    );
    expect(result.horizon).toBe("1000");
  });

  it("stringifies bigint ids, which JSON.stringify would otherwise throw on", async () => {
    const result = await runWaitForCrew(
      contextFor(ledger([row(5, "note")]), 240, 5),
      { since: "0", limit: 50 },
      { clock: virtualClock() },
    );
    expect(result.events[0]?.id).toBe("5");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
