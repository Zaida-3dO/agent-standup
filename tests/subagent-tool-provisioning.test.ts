// A dispatched agent that cannot use a tool its brief named — the
// `report_blocked_on_tool` operation and I19's narrowed nudge.
//
// **The two halves are tested together deliberately.** They are one
// mechanism split across a boundary: the operation is how a stalled agent
// says something, and the entry is what the orchestrator is told next time
// it dispatches. Testing them apart would let the pair drift into a state
// where each is individually correct and nothing joins them up — which is
// exactly the failure they exist to prevent, one level down.
//
// Neither half needs a database. Zod validates before any handler runs, so
// the schema cases are pure; the predicate reads only the context it is
// handed, which is the contract `types.ts` establishes.
//
// **The handler is tested here too, against a recording stub** — see the
// third `describe`. An earlier revision of this header claimed its
// behaviour was "covered by the DB-gated suites", and that was false: no
// suite in `tests/` exercised this handler at all, DB-gated or otherwise.
// The claim was not merely wrong, it was load-bearing — it is what made
// the absence look deliberate, and five mutations of the handler survived
// the full suite behind it (the event type, the payload key the sweep
// joins on, the actor type, the nonexistent-item guard, and the headline
// split). A sentence asserting coverage that does not exist is worse than
// no sentence, because it stops the next reader from looking.

import { describe, expect, it } from "vitest";
import {
  reportBlockedOnTool,
  BLOCKED_ON_TOOL_REASONS,
} from "@/lib/service/operations/report-blocked-on-tool";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { NotFoundError } from "@/lib/service/errors";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import type { Intervention, InterventionContext } from "@/lib/interventions/types";

const ENTRY_ID = "dispatch-over-unresolved-tool-block";

function entry(id: string): Intervention {
  const found = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no builtin entry ${id}`);
  return found;
}

/** A minimal valid call, varied per case. */
function call(over: Record<string, unknown> = {}) {
  return {
    itemId: "0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
    tool: "checkpoint",
    needed: "The brief said to checkpoint against this id as I go.",
    ...over,
  };
}

describe("report_blocked_on_tool — the stall channel", () => {
  it("is reachable through the operation registry", () => {
    // The registry is what every adapter derives from, so an operation
    // absent from it is unreachable on MCP, HTTP and the command line at
    // once — the tool would exist and no dispatched agent could call it.
    expect(OPERATION_REGISTRY["report_blocked_on_tool"]).toBe(reportBlockedOnTool);
    expect(reportBlockedOnTool.kind).toBe("write");
  });

  it("accepts a report naming the tool and what the brief asked for", () => {
    const parsed = reportBlockedOnTool.input.safeParse(call());
    expect(parsed.success).toBe(true);
  });

  it("refuses a report that does not name the tool", () => {
    // A report that cannot say WHICH tool leaves the orchestrator with
    // nothing to fix, which is the whole value of the row.
    expect(reportBlockedOnTool.input.safeParse(call({ tool: "" })).success).toBe(false);
    expect(reportBlockedOnTool.input.safeParse(call({ tool: "   " })).success).toBe(false);
    const { tool: _tool, ...withoutTool } = call();
    expect(reportBlockedOnTool.input.safeParse(withoutTool).success).toBe(false);
  });

  it("refuses a report that does not say what the brief asked for", () => {
    // The orchestrator is correcting an INSTRUCTION. "checkpoint is
    // unavailable" does not identify one; "the brief said to checkpoint as
    // I go" does.
    expect(reportBlockedOnTool.input.safeParse(call({ needed: "" })).success).toBe(false);
    const { needed: _needed, ...withoutNeeded } = call();
    expect(reportBlockedOnTool.input.safeParse(withoutNeeded).success).toBe(false);
  });

  it("defaults an unstated reason to `unknown` rather than guessing one", () => {
    // An agent that was refused and cannot tell whether the tool was
    // ungranted or merely unusable must not be pushed into picking one:
    // the two have different fixes, and a confident wrong classification
    // sends the orchestrator to the wrong one.
    const parsed = reportBlockedOnTool.input.safeParse(call());
    expect(parsed.success && parsed.data.reason).toBe("unknown");
  });

  it("keeps `not_granted` and `refused` as separate answers", () => {
    // The distinction is the entire design point. `not_granted` is fixed by
    // editing the agent definition; `refused` means the tool is already in
    // that list and editing it changes nothing. Collapsing them would make
    // the nudge advise the wrong remedy half the time.
    expect([...BLOCKED_ON_TOOL_REASONS].sort()).toEqual(["not_granted", "refused", "unknown"]);
    for (const reason of BLOCKED_ON_TOOL_REASONS) {
      expect(reportBlockedOnTool.input.safeParse(call({ reason })).success, reason).toBe(true);
    }
    expect(reportBlockedOnTool.input.safeParse(call({ reason: "maybe" })).success).toBe(false);
  });

  it("does not require a session, because a dispatched agent may hold no claim", () => {
    // **The property this operation exists for.** A dispatched subagent
    // normally holds no claim — the orchestrator holds it — and requiring
    // one here would reproduce, inside the reporting channel, the exact
    // failure the channel reports.
    expect(reportBlockedOnTool.input.safeParse(call()).success).toBe(true);
    expect(reportBlockedOnTool.input.safeParse(call({ sessionId: "s1" })).success).toBe(true);
  });

  it("carries the refusal verbatim when there was one, and tolerates none", () => {
    expect(
      reportBlockedOnTool.input.safeParse(call({ refusal: "You hold no claim." })).success,
    ).toBe(true);
    expect(reportBlockedOnTool.input.safeParse(call({ refusal: null })).success).toBe(true);
  });

  it("rejects a field it does not recognise", () => {
    // `.strict()`, so a caller misspelling `reason` is told rather than
    // having its classification silently dropped to the default.
    expect(reportBlockedOnTool.input.safeParse(call({ resaon: "refused" })).success).toBe(false);
  });

  it("declares the conditional rule its schema cannot state", () => {
    // The reason vocabulary looks self-explanatory and is not: which of the
    // two a caller is in decides whether editing the tool list helps at
    // all, and no enum can say that.
    const rules = reportBlockedOnTool.contract?.rules ?? [];
    expect(rules.some((rule) => rule.fields.includes("reason"))).toBe(true);
    expect(rules.some((rule) => rule.fields.includes("needed"))).toBe(true);
  });

  it("offers an example its own schema accepts", () => {
    // An example that would be refused is worse than none: a caller copies
    // it, is rejected, and concludes the operation is broken.
    const example = reportBlockedOnTool.contract?.example;
    expect(example).toBeDefined();
    expect(reportBlockedOnTool.input.safeParse(example).success).toBe(true);
  });
});

describe("I19 — dispatching over a tool block nobody cleared", () => {
  async function fires(context: InterventionContext): Promise<boolean> {
    return (await entry(ENTRY_ID).predicate(context)).triggered;
  }

  it("fires when an earlier agent reported a tool it could not use", async () => {
    expect(
      await fires({
        unresolvedToolBlocks: [{ tool: "checkpoint", reason: "refused" }],
      }),
    ).toBe(true);
  });

  it("stays silent when nothing was reported", async () => {
    // Absent is "the server did not look, or looked and found none", and an
    // entry that fired on it would fire on every dispatch in the system —
    // the "fires and annoys" failure that earns an entry a 1.
    expect(await fires({})).toBe(false);
    expect(await fires({ unresolvedToolBlocks: [] })).toBe(false);
  });

  it("names the tools and their reasons on the finding", async () => {
    // The catalogue asks this entry to name what is missing rather than
    // remind in the abstract, so the data has to carry it through — a
    // verdict of a bare `triggered: true` could not.
    const verdict = await entry(ENTRY_ID).predicate({
      unresolvedToolBlocks: [
        { tool: "checkpoint", reason: "refused" },
        { tool: "browser_claim", reason: "not_granted" },
      ],
    });

    expect(verdict.data).toEqual({
      tools: ["checkpoint", "browser_claim"],
      reasons: ["refused", "not_granted"],
    });
  });

  it("nudges rather than blocks", async () => {
    // Dispatching over a known block is often correct: the next agent may
    // not need the tool, or the orchestrator may have already fixed the
    // definition and be spawning a new session precisely because that is
    // the only way to pick the fix up. Blocking would refuse the remedy.
    expect(entry(ENTRY_ID).defaultLevel).toBe("nudge");
    expect(entry(ENTRY_ID).phase).toBe("pre");
    expect(entry(ENTRY_ID).audience).toBe("orchestrator");
  });

  it("tells the orchestrator that the fix needs a new session", async () => {
    // The editing constraint that makes this remedy non-obvious: an
    // agent-definition edit does not take effect in the session that made
    // it, so an orchestrator that edits and immediately re-dispatches from
    // the same session sees no change and concludes the edit did not work.
    for (const text of Object.values(entry(ENTRY_ID).messages)) {
      expect(text).toMatch(/new session/i);
    }
  });

  it("says that editing the tool list does not fix a granted-but-refused tool", async () => {
    // The half a check keyed only on the allowlist would miss. Without
    // this, the message's advice is wrong for one of the two reasons it
    // reports — and it is the reason behind the more recent incident.
    expect(entry(ENTRY_ID).messages.prominent).toMatch(/granted and refused/i);
    expect(entry(ENTRY_ID).messages.plain).toMatch(/granted and refused/i);
  });

  it("does not claim that a subagent cannot reach the board", async () => {
    // A guard rail on the guard rail. This entry teaches something about
    // tool availability, and the lesson has to be the accurate one: a
    // sweeping "subagents cannot record anything" is just as wrong and far
    // stickier. Only operations with a claim precondition behave this way —
    // recording an artifact succeeds for a caller holding no claim — so the
    // message must not generalise from the one to all of them.
    for (const text of Object.values(entry(ENTRY_ID).messages)) {
      expect(text).not.toMatch(/cannot (reach|record|use) the board/i);
    }
  });
});

describe("report_blocked_on_tool — what the handler actually writes", () => {
  // **Why a stub database rather than the DB-gated suites.** Everything
  // this handler does at the boundary goes through `$queryRawUnsafe`, so
  // recording the statements and their positional parameters observes the
  // row it would insert exactly — the column list in `events-insert.ts` is
  // one fixed INSERT, so `$6` is the event type and `$7` the payload
  // whether Postgres is there or not. The claims below are about *which
  // values this handler chooses*, and every one of those is decided before
  // a driver is reached. A real database would re-prove Postgres's insert
  // and nothing about the choices, at the cost of a suite that skips on
  // every machine without `TEST_DATABASE_URL` — which is exactly where
  // these behaviours went unasserted.
  const ITEM = "0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d";

  interface Recorded {
    readonly sql: string;
    readonly params: readonly unknown[];
  }

  /**
   * A `TransactionHandle` answering the two reads this handler makes, and
   * recording the insert.
   *
   * `itemExists` is a parameter rather than always true because the
   * nonexistent-item rejection is one of the behaviours under test, and a
   * stub that always found the item could not tell a live guard from a
   * deleted one.
   */
  function stubDb(
    options: { itemExists?: boolean; assignment?: { id: string; holderId: string } } = {},
  ) {
    const { itemExists = true, assignment } = options;
    const calls: Recorded[] = [];
    const db = {
      async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
        calls.push({ sql, params });
        if (sql.includes('FROM "Item"')) return (itemExists ? [{ id: ITEM }] : []) as T;
        if (sql.includes('FROM "Assignment"')) return (assignment ? [assignment] : []) as T;
        if (sql.includes('INSERT INTO "Event"')) {
          return [{ id: 1n, txId: 2n, ts: new Date("2026-09-03T00:00:00Z") }] as T;
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      async $executeRawUnsafe(): Promise<number> {
        throw new Error("the handler should not be executing raw statements");
      },
    };
    return {
      db,
      calls,
      insert: () => calls.find((entry) => entry.sql.includes('INSERT INTO "Event"')),
    };
  }

  type Handler = typeof reportBlockedOnTool.handler;
  type Stub = ReturnType<typeof stubDb>;

  function ctx(db: Stub["db"]): Parameters<Handler>[0] {
    return {
      db,
      operation: "report_blocked_on_tool",
      caller: {},
    } as unknown as Parameters<Handler>[0];
  }

  /** Runs the handler and reads back the `Event` insert's positional parameters. */
  async function writtenRow(over: Record<string, unknown> = {}, stubOptions = {}) {
    const stub = stubDb(stubOptions);
    await reportBlockedOnTool.handler(ctx(stub.db), reportBlockedOnTool.input.parse(call(over)));
    const insert = stub.insert();
    if (insert === undefined) throw new Error("no Event insert was made");
    // Positional, per the single INSERT in `events-insert.ts`: $1 itemId,
    // $2 actorType, $3 actorId, $4 sessionId, $5 assignmentId, $6 type,
    // $7 payload (json), $8 body, $9 headline.
    const [itemId, actorType, actorId, sessionId, assignmentId, type, payload, body, headline] =
      insert.params;
    return {
      itemId,
      actorType,
      actorId,
      sessionId,
      assignmentId,
      type,
      payload: JSON.parse(String(payload)) as Record<string, unknown>,
      body,
      headline,
    };
  }

  it("writes an `escalation`, the crew event type that wakes a waiting orchestrator", async () => {
    // **The PR's central claim.** `escalation` is in `CREW_EVENT_TYPES`, so
    // an orchestrator sitting in a wait on its crew is woken by this row.
    // `note` is in that set too, but it is the ordinary channel for
    // everything an agent has to say — writing one here would put "I am
    // stopped" back among the progress prose the orchestrator has to read
    // to find it, which is the situation this operation exists to remove.
    expect((await writtenRow()).type).toBe("escalation");
  });

  it("keys the payload on `blocked_on_tool`, which is what the sweep joins on", async () => {
    // **The most consequential of these.** `toolBlocksFor` selects on
    // `payload ? 'blocked_on_tool'`. Rename this key and the write still
    // succeeds, the row still renders in the history, and I19's shipped
    // half never fires again — silently and permanently, because nothing
    // anywhere compares the writer's spelling to the reader's.
    const { payload } = await writtenRow({ tool: "browser_claim" });
    expect(Object.keys(payload)).toContain("blocked_on_tool");
    expect(payload["blocked_on_tool"]).toBe("browser_claim");
  });

  it("attributes the row to an `agent`, never a person", async () => {
    // A person who cannot use a tool does not stall and report to an
    // orchestrator, they go and fix it. The one caller this operation has
    // is a dispatched agent, and `person` would misattribute every row it
    // writes.
    expect((await writtenRow()).actorType).toBe("agent");
  });

  it("refuses a report against an item that does not exist", async () => {
    // Without the check the operation accepts a report keyed to nothing:
    // the event is written against an id no item has, so it is unreadable
    // from any item and the orchestrator is never told.
    const stub = stubDb({ itemExists: false });
    await expect(
      reportBlockedOnTool.handler(ctx(stub.db), reportBlockedOnTool.input.parse(call())),
    ).rejects.toThrow(NotFoundError);
    expect(stub.insert(), "wrote an event for a nonexistent item").toBeUndefined();
  });

  it("headlines `not_granted` and `refused` differently, because the remedies differ", async () => {
    // The distinction the whole operation is built around, at the one place
    // the orchestrator reads before opening anything. Collapsing both into
    // a neutral word ("unavailable") erases it exactly where it is needed.
    const notGranted = await writtenRow({ tool: "checkpoint", reason: "not_granted" });
    const refused = await writtenRow({ tool: "checkpoint", reason: "refused" });
    const unknown = await writtenRow({ tool: "checkpoint", reason: "unknown" });

    expect(notGranted.headline).toBe("Stalled: `checkpoint` is not granted to this agent");
    expect(refused.headline).toBe("Stalled: `checkpoint` is granted but refused");
    expect(unknown.headline).toBe("Stalled: `checkpoint` is unavailable");
    // Three distinct strings, so no later edit can quietly merge two of
    // them while each assertion above still reads plausibly on its own.
    expect(new Set([notGranted.headline, refused.headline, unknown.headline]).size).toBe(3);
  });

  it("records the reason, the instruction, and addresses nobody human", async () => {
    const row = await writtenRow({ reason: "refused", needed: "Checkpoint against this id." });
    expect(row.payload["reason"]).toBe("refused");
    expect(row.body).toBe("Checkpoint against this id.");
    // `to_person: null` matches what the liveness sweep writes: addressed
    // to the orchestrator, not escalated to a human.
    expect(row.payload["to_person"]).toBeNull();
  });

  it("carries a refusal when given one and omits the key entirely when not", async () => {
    expect((await writtenRow({ refusal: "You hold no claim." })).payload["refusal"]).toBe(
      "You hold no claim.",
    );
    expect(Object.keys((await writtenRow()).payload)).not.toContain("refusal");
  });

  it("writes for a caller holding no assignment, attributing it to nobody", async () => {
    // The property the operation exists for: a dispatched agent holds no
    // claim, and this call must still land.
    const row = await writtenRow({ sessionId: "crew-session-1" });
    expect(row.assignmentId).toBeNull();
    expect(row.actorId).toBeNull();
    expect(row.sessionId).toBe("crew-session-1");
  });

  it("attributes the row to the holder when the caller does hold one", async () => {
    // The assignment is looked up to attribute, never to gate — so when
    // there is one, it is used.
    const stub = stubDb({ assignment: { id: "assign-1", holderId: "holder-1" } });
    await reportBlockedOnTool.handler(
      ctx(stub.db),
      reportBlockedOnTool.input.parse(call({ sessionId: "crew-session-1" })),
    );
    const insert = stub.insert();
    expect(insert?.params[4]).toBe("assign-1");
    expect(insert?.params[2]).toBe("holder-1");
  });
});
