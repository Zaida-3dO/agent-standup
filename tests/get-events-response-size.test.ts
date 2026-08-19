// `get_events` response size — the bounded-reads sweep this file pins down.
//
// **What broke, concretely.** `GET /api/events` at the operation's own
// default `limit` (50) returned 547,961 characters against the
// response-size guard's 200,000-character ceiling (`response-size.ts`),
// because the full event shape carries `payload` and `body` on every row —
// two fields that together measured 95% of one event's size on a live
// store. This file pins the fix: the DEFAULT shape must fit comfortably
// under the ceiling at realistic row sizes, and the size difference between
// the slim default and `full: true` has to be real, not cosmetic.
//
// **What would make this hollow.** Asserting `full: false` produces
// *smaller output than `full: true`* would pass even if the slim shape
// still carried an unbounded field alongside the six identifying scalars —
// smaller is not the same claim as bounded. The load-bearing assertion
// below is therefore an absolute one: many heavy events, through the real
// runtime, and the slim response must fit under a fixed, small ceiling
// while the full response is shown blowing well past it — the same
// oversized-input shape `response-size.test.ts` uses for the guard itself,
// pointed at this operation specifically because it is the one that broke.
import { describe, expect, it } from "vitest";
import { ServiceRuntime } from "@/lib/service";
import { MAX_RESPONSE_CHARS } from "@/lib/service/response-size";
import { defaultSnapshot } from "@/lib/settings";

/** A payload/body pair sized like the measured live-store average (payload 4,512 + body 2,532 = 7,044 of a 7,398-char event). */
function heavyPayload(chars: number): Record<string, unknown> {
  return {
    field: "body",
    from: "x".repeat(Math.floor(chars / 2)),
    to: "x".repeat(Math.ceil(chars / 2)),
  };
}

/**
 * A runtime whose "database" answers `get_events`'s own query sequence:
 * the visibility horizon, the event rows themselves (slim or full columns,
 * decided by which columns the SQL asked for — the same thing
 * `readSinceBounded` decides in the real query), then the two follow-up
 * lookups (`EventSeen`, `Item` titles) as empty, since neither is what this
 * file is testing.
 *
 * Routing on the SQL text rather than call order is deliberate: call order
 * is an implementation detail of `get_events`' handler, and a test coupled
 * to it would break on a harmless reordering having proven nothing about
 * response size.
 */
function runtimeReturningEvents(count: number, payloadBodyChars: number): ServiceRuntime {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: BigInt(i + 1),
    txId: BigInt(1),
    itemId: null,
    ts: new Date(0),
    actorType: "agent",
    actorId: `builder-${i}`,
    sessionId: null,
    assignmentId: null,
    type: "field_change",
    payload: heavyPayload(payloadBodyChars),
    body: "x".repeat(payloadBodyChars),
  }));

  return new ServiceRuntime({
    transaction: async (body) =>
      body({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes("pg_snapshot_xmin")) return [{ horizon: 999n }];
          if (sql.includes('FROM "EventSeen"')) return [];
          if (sql.includes('FROM "Item"')) return [];
          if (sql.includes('FROM "Event"')) {
            // The slim query never selects "payload" or "body" at all — see
            // `EVENT_SLIM_COLUMNS` (`@/lib/events`) — so mirroring that
            // column choice here is what makes this fixture stand in for
            // the real query rather than merely for the operation's own
            // post-processing of it.
            if (!sql.includes('"payload"')) {
              return rows.map(({ id, itemId, ts, actorType, actorId, type }) => ({
                id,
                itemId,
                ts,
                actorType,
                actorId,
                type,
              }));
            }
            return rows;
          }
          throw new Error(`unexpected query in test: ${sql}`);
        },
        $executeRawUnsafe: async () => 0,
      } as never),
    resolveSnapshot: async () => defaultSnapshot(),
  });
}

describe("get_events response size — the slim default versus full: true", () => {
  // THE load-bearing assertion. 50 events at the measured heavy size would
  // have reproduced the real 547,961-character failure under the old
  // always-full shape; the slim default has to keep the same row count
  // comfortably under the guard's ceiling.
  it("keeps the default (full: false) response bounded well under the response-size ceiling, at the row count and event size that broke the page", async () => {
    const runtime = runtimeReturningEvents(50, 7044);
    const result = (await runtime.call("get_events", { limit: 50 })) as {
      events: readonly unknown[];
    };
    expect(result.events).toHaveLength(50);
    const size = JSON.stringify(result).length;
    // Comfortably under the ceiling, not merely under it — the slim shape
    // should not be riding the guard's edge at an ordinary page size.
    expect(size).toBeLessThan(MAX_RESPONSE_CHARS / 4);
  });

  // The negative control: the same events, the same count, `full: true` —
  // and the response-size guard itself refuses it. Without this, the
  // assertion above could pass because the fixture never carried the heavy
  // fields at all, rather than because the slim shape dropped them. Going
  // through the real runtime (not just `responseSize`) is what makes this
  // the same reproduction as the actual 547,961-character failure: the
  // guard rejecting the call IS the oversized response, caught before it
  // ever reaches a caller.
  it("the response-size guard refuses the same rows at full: true — proving the slim shape is what saves it, not the fixture", async () => {
    const runtime = runtimeReturningEvents(50, 7044);
    await expect(runtime.call("get_events", { limit: 50, full: true })).rejects.toMatchObject({
      code: "guard_rejected",
    });
  });

  // Every event in the slim response actually lacks the heavy fields —
  // proving the saving is structural (the fields are absent) rather than
  // the two happening to serialise to a similar size by coincidence.
  it("omits payload and body from every event in the slim shape", async () => {
    const runtime = runtimeReturningEvents(5, 500);
    const result = (await runtime.call("get_events", { limit: 5 })) as unknown as {
      events: readonly Record<string, unknown>[];
    };
    for (const event of result.events) {
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("body");
    }
  });

  // And the inverse: full: true genuinely restores them, so the parameter
  // is not decorative.
  it("carries payload and body on every event when full: true", async () => {
    const runtime = runtimeReturningEvents(5, 500);
    const result = (await runtime.call("get_events", { limit: 5, full: true })) as unknown as {
      events: readonly Record<string, unknown>[];
    };
    for (const event of result.events) {
      expect(event).toHaveProperty("payload");
      expect(event).toHaveProperty("body");
    }
  });
});
