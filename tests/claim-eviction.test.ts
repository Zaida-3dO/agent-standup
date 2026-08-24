// Lazy eviction of stale claims (src/lib/claim-eviction.ts, and its wiring
// into the `claim` operation).
//
// **What this file has to prove, and why it is split in two.**
//
// The pure judgement (`judgeEviction`) is all boundaries — "at the
// threshold minus one second nothing happens, at the threshold it does" —
// and a boundary tested through a database is tested by whatever `now` the
// test happened to construct. Those cases run everywhere, with time
// injected.
//
// The wiring is the opposite: the claim path is an `INSERT ... ON CONFLICT
// DO NOTHING` against two partial unique indexes, and the whole question is
// whether releasing a row actually lets the retried insert through. Nothing
// but Postgres can answer that, so those cases gate on TEST_DATABASE_URL
// like every other DB-backed file here.
//
// **The case that matters most is the negative one.** Evicting a stranded
// claim is the feature; NOT evicting a live builder is the safety property,
// and it is the one a regression would ship silently — a too-eager eviction
// produces a green suite and two agents on one item in production. So the
// live-holder cases are asserted from several directions: recently
// heartbeated, never heartbeated but making tool calls, and freshly claimed.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, isServiceError, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot, resolveSettings, SETTINGS_REGISTRY } from "@/lib/settings";
import { evictStaleHolders, judgeEviction, type EvictionInputs } from "@/lib/claim-eviction";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const NOW = new Date("2026-08-19T12:00:00.000Z");

/** Seconds before `NOW`, as a Date. */
function agoSeconds(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

/**
 * Eviction inputs for a holder that claimed long ago and has been quiet
 * ever since — the stranded case — overridable per assertion.
 */
function inputs(overrides: Partial<EvictionInputs> = {}): EvictionInputs {
  return {
    liveness: "running",
    releasedAt: null,
    lastActive: agoSeconds(10_000),
    claimedAt: agoSeconds(10_000),
    lastToolCallAt: null,
    now: NOW,
    evictAfterSeconds: 3_600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The judgement — pure, no database.
// ---------------------------------------------------------------------------

describe("judgeEviction — what counts as evidence that a holder is gone", () => {
  it("evicts a holder quiet for longer than the threshold on a long-standing claim", () => {
    // The stranded claim this whole row exists to free: claimed hours ago,
    // no heartbeat since, no tool calls at all.
    const judgement = judgeEviction(inputs());
    expect(judgement.verdict).toBe("evictable");
    expect(judgement.unseenForSeconds).toBe(10_000);
  });

  it("does NOT evict a holder seen one second inside the threshold", () => {
    // The boundary, from the safe side. Paired with the case below, this
    // pins the comparison rather than either of its branches: a mutant
    // flipping `<` to `<=` changes exactly one of these two.
    const judgement = judgeEviction(
      inputs({ lastActive: agoSeconds(3_599), evictAfterSeconds: 3_600 }),
    );
    expect(judgement.verdict).toBe("recently_seen");
    expect(judgement.unseenForSeconds).toBe(3_599);
  });

  it("evicts a holder unseen for exactly the threshold", () => {
    // The other side of the same boundary. `>=` is the intended reading —
    // "unseen for the threshold" is the condition, not "unseen for longer".
    expect(
      judgeEviction(inputs({ lastActive: agoSeconds(3_600), evictAfterSeconds: 3_600 })).verdict,
    ).toBe("evictable");
  });

  // -- the second, independent signal --------------------------------------

  it("treats a recent tool call as being seen, even with an ancient heartbeat", () => {
    // **The case the whole design turns on.** For a session that neither
    // runs the hook nor calls `heartbeat`, `lastActive` is frozen at its
    // claim, so reading that column alone would evict it mid-run while its
    // tool calls are the signal that actually moves. (A session whose hook
    // flushes now stamps `lastActive` too — see `record_tool_calls` — but
    // this judgement must stay correct for the one that does not.)
    //
    // A mutant that drops `lastToolCallAt` from the max — reading only the
    // heartbeat — turns this row back into "evictable" and fails here.
    const judgement = judgeEviction(
      inputs({ lastActive: agoSeconds(10_000), lastToolCallAt: agoSeconds(30) }),
    );
    expect(judgement.verdict).toBe("recently_seen");
    expect(judgement.unseenForSeconds).toBe(30);
    expect(judgement.lastSeenSignal).toBe("tool_call");
  });

  it("treats a recent heartbeat as being seen, even with ancient tool calls", () => {
    // The mirror image, and it is not redundant: a mutant reading only
    // `lastToolCallAt` — dropping the heartbeat side of the max — passes
    // the case above and fails this one. Together they pin `Math.max`
    // rather than either operand.
    const judgement = judgeEviction(
      inputs({ lastActive: agoSeconds(30), lastToolCallAt: agoSeconds(10_000) }),
    );
    expect(judgement.verdict).toBe("recently_seen");
    expect(judgement.unseenForSeconds).toBe(30);
    expect(judgement.lastSeenSignal).toBe("heartbeat");
  });

  it("evicts when BOTH signals are past the threshold", () => {
    // Neither signal alone rescuing the row is what makes the two above
    // assertions about the max rather than about "any signal wins".
    expect(
      judgeEviction(inputs({ lastActive: agoSeconds(9_000), lastToolCallAt: agoSeconds(8_000) }))
        .verdict,
    ).toBe("evictable");
  });

  // -- the claim-age floor -------------------------------------------------

  it("does NOT evict on a claim younger than the threshold, however stale its timestamps look", () => {
    // A row claimed a minute ago cannot have been quiet for an hour. This
    // is the guard against a clock skew, a restored backup or an imported
    // row manufacturing an eviction: `claimedAt` is written by the database
    // on insert, where `lastActive` is a value a client can supply.
    //
    // Deleting the `claimAgeSeconds` term makes this case evictable.
    const judgement = judgeEviction(
      inputs({
        claimedAt: agoSeconds(60),
        lastActive: agoSeconds(10_000),
        evictAfterSeconds: 3_600,
      }),
    );
    expect(judgement.verdict).toBe("recently_seen");
  });

  // -- rows something else already decided ---------------------------------

  it("reports an already-released row as already_released, without consulting the clock", () => {
    const judgement = judgeEviction(inputs({ releasedAt: agoSeconds(5) }));
    expect(judgement.verdict).toBe("already_released");
    // Null rather than a number: no elapsed time could change this answer,
    // and reporting a duration would imply the decision turned on one.
    expect(judgement.unseenForSeconds).toBeNull();
  });

  it("reports a superseded row as already_released", () => {
    // A takeover already decided this row's fate. Judging it again would
    // let the lazy path re-release a row whose supersession is the record
    // of who displaced whom.
    expect(judgeEviction(inputs({ liveness: "superseded" })).verdict).toBe("already_released");
  });

  it("still judges a `dead` row on the evidence rather than trusting the rung", () => {
    // Deliberate, and the opposite of what `takeover`'s `judgeHolder` does.
    // The sweep computes `dead` from `lastActive` alone — the signal known
    // to be unreliable here — so a row marked `dead` at 1800s of a column
    // that never moves is exactly the false positive this module must not
    // act on. A recently-active tool call overrides the rung.
    expect(judgeEviction(inputs({ liveness: "dead", lastToolCallAt: agoSeconds(5) })).verdict).toBe(
      "recently_seen",
    );
  });

  it("reads the threshold from its argument rather than a constant", () => {
    // The same row, judged both ways by moving only the threshold. A
    // hard-coded bound passes one of these and fails the other.
    const quiet = { lastActive: agoSeconds(5_000), claimedAt: agoSeconds(5_000) };
    expect(judgeEviction(inputs({ ...quiet, evictAfterSeconds: 4_000 })).verdict).toBe("evictable");
    expect(judgeEviction(inputs({ ...quiet, evictAfterSeconds: 6_000 })).verdict).toBe(
      "recently_seen",
    );
  });
});

describe("the eviction threshold is declared once, as a setting", () => {
  it("registers `liveness.evict_after_seconds`, defaulted well above the dead threshold", () => {
    const evict = SETTINGS_REGISTRY["liveness.evict_after_seconds"];
    const dead = SETTINGS_REGISTRY["liveness.dead_after_seconds"];

    // The gap is the point, not the exact number. The sweep's thresholds
    // assume `lastActive` is stamped on every tool call; a session running
    // no hook and never calling `heartbeat` stamps it never, so reusing
    // `dead_after_seconds` for eviction would take claims from sessions
    // that are merely working.
    expect(evict.default).toBeGreaterThan(dead.default as number);

    // Lowering it evicts live holders, so it relaxes an enforcement in the
    // dangerous direction and must carry the flag that puts it behind the
    // confirmation and its own audit event (§17.8).
    expect(evict.sensitive).toBe(true);

    // Read on the next contending claim, not on a sweep. Declaring it
    // `next-sweep` would tell an operator the opposite of when their change
    // takes effect — and on a deployment with no scheduler, "next sweep"
    // may be never.
    expect(evict.appliesWhen).toBe("next-call");
  });

  it("states the honest caveat about the heartbeat in the setting's own help text", () => {
    // The acceptance criterion is that the threshold and its inputs are
    // stated in ONE place including the note that heartbeats may not be
    // written. The module header carries the full reasoning; this is the
    // half an operator actually reads, in the admin UI, so the caveat has
    // to survive here too.
    const help = SETTINGS_REGISTRY["liveness.evict_after_seconds"].help.toLowerCase();
    expect(help).toContain("heartbeat");
    expect(help).toContain("tool call");
    expect(help).toContain("takeover");
    // The caveat must name *which* sessions are exposed now that the hook's
    // flush stamps `last_active`. "Liveness may not be written" was true of
    // everyone before; saying it unqualified now would overstate the risk
    // and invite lowering the threshold for the wrong reason.
    expect(help).toContain("no hook");
  });

  it("does not describe a process check in any liveness setting's help text", () => {
    // There is no process check — `stale_after_seconds` used to say one
    // "comes first". An operator reading that reasons about their claims
    // surviving on evidence the system never gathers, which is the whole of
    // the liveness-docs defect. A mutant restoring that phrasing fails here.
    for (const key of [
      "liveness.stale_after_seconds",
      "liveness.dead_after_seconds",
      "liveness.evict_after_seconds",
    ] as const) {
      const help = SETTINGS_REGISTRY[key].help.toLowerCase();
      expect(help).not.toContain("process check comes first");
      expect(help).not.toMatch(/a process check[^.]*\bfallback\b/);
    }
    // And the one that used to make the claim now states the negative
    // outright, so the correction cannot be silently dropped.
    expect(SETTINGS_REGISTRY["liveness.stale_after_seconds"].help.toLowerCase()).toContain(
      "no process check",
    );
  });
});

// ---------------------------------------------------------------------------
// The wiring — against a real Postgres.
// ---------------------------------------------------------------------------

describeIfDb("claim evicts a stale holder at contention — against Postgres", () => {
  const dbName = scratchDatabaseName("claim_eviction");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.toolCall.deleteMany({});
    // `Run` before `Assignment`: a case that drives the real
    // `record_tool_calls` ingest opens a run against the holder's
    // assignment (§11 — a run is one agent's turn on one item), and
    // `Run_assignmentId_fkey` then refuses the assignment delete. Without
    // this the failure surfaces in *every following case* rather than the
    // one that wrote the row, which is how it first presented.
    await prisma.run.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  /** The shipped defaults, so the ordinary path is what is under test. */
  function runtime(): ServiceRuntime {
    return new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }

  /**
   * A runtime with the eviction threshold overridden, so a holder seeded a
   * few seconds back is already evictable.
   *
   * Overriding the setting rather than seeding a four-hour-old fixture is
   * deliberate: it proves the operation reads the threshold from the
   * snapshot rather than from a constant, which a fixture with a huge time
   * offset cannot distinguish.
   */
  function runtimeEvictingAfter(seconds: number): ServiceRuntime {
    return new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () =>
        resolveSettings({
          overrides: [{ key: "liveness.evict_after_seconds", value: seconds }],
          revision: 1n,
        }),
    });
  }

  async function seedItem(): Promise<string> {
    itemCounter += 1;
    const id = `item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "executing",
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /** A live claim held by `sessionId`, quiet since `quietForSeconds` ago. */
  async function seedHolder(
    itemId: string,
    sessionId: string,
    quietForSeconds: number,
    role: "orchestrator" | "builder" = "orchestrator",
  ): Promise<string> {
    const when = new Date(Date.now() - quietForSeconds * 1000);
    const row = await prisma.assignment.create({
      data: {
        itemId,
        role,
        holderType: "agent",
        holderId: "holder-a",
        sessionId,
        rootSessionId: sessionId,
        machine: "laptop",
        claimedAt: when,
        lastActive: when,
      },
    });
    return row.id;
  }

  /** A claim by a second, unrelated crew — the contending call. */
  function contendingClaim(itemId: string, sessionId = "session-newcomer") {
    return {
      itemId,
      role: "orchestrator" as const,
      holderType: "agent" as const,
      holderId: "holder-b",
      sessionId,
      machine: "laptop",
    };
  }

  it("takes the claim from a demonstrably stale holder, and records the eviction", async () => {
    // The acceptance criterion, end to end through the operation: before
    // this row the stranded holder refused every later claim forever, and
    // with the scheduler removed nothing anywhere would ever release it.
    const itemId = await seedItem();
    const strandedId = await seedHolder(itemId, "session-stranded", 10_000);

    const result = (await runtimeEvictingAfter(60).call(
      "claim",
      contendingClaim(itemId),
    )) as unknown as {
      id: string;
      sessionId: string;
      evicted: { assignmentId: string; sessionId: string; unseenForSeconds: number }[];
    };

    // The newcomer actually holds it now.
    expect(result.sessionId).toBe("session-newcomer");

    // The eviction is reported to the caller, naming what it took.
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0]?.assignmentId).toBe(strandedId);
    expect(result.evicted[0]?.sessionId).toBe("session-stranded");
    expect(result.evicted[0]?.unseenForSeconds).toBeGreaterThanOrEqual(10_000);

    // The stranded row is released and marked dead, both — a released row
    // still marked `running` is a state nothing chose.
    const stranded = await prisma.assignment.findUniqueOrThrow({ where: { id: strandedId } });
    expect(stranded.releasedAt).not.toBeNull();
    expect(stranded.liveness).toBe("dead");
  });

  it("records the eviction as an auditable release event naming the evidence", async () => {
    // "Recorded so it is auditable rather than silent" is an acceptance
    // criterion in its own right. An item that changed hands with nothing
    // in its history saying why leaves the next reader unable to tell a
    // decision from a defect.
    const itemId = await seedItem();
    const strandedId = await seedHolder(itemId, "session-stranded", 10_000);

    await runtimeEvictingAfter(60).call("claim", contendingClaim(itemId));

    const release = await prisma.event.findFirstOrThrow({
      where: { itemId, type: "release" },
      orderBy: { id: "desc" },
    });
    expect(release.assignmentId).toBe(strandedId);

    // Credited to `system`, not to the claiming agent: the claimer asked to
    // claim, it did not decide to release anyone. Attributing an automatic
    // reclaim to a session would put a name on a decision nobody made.
    expect(release.actorType).toBe("system");

    // The body has to carry the evidence, or the audit trail records that
    // something happened without recording what it was decided on.
    const body = release.body ?? "";
    expect(body).toContain("session-stranded");
    expect(body).toContain("session-newcomer");
    // The honest half, matching what `takeover` tells its callers: the row
    // is released, the holder is not stopped.
    expect(body.toLowerCase()).toContain("not");
  });

  it("does NOT evict a holder that heartbeated recently — the live-builder case", async () => {
    // **The safety property, and the one a regression ships silently.** A
    // too-eager eviction produces a green suite and two agents editing one
    // branch in production.
    const itemId = await seedItem();
    const liveId = await seedHolder(itemId, "session-live", 10);

    await expect(runtime().call("claim", contendingClaim(itemId))).rejects.toSatisfy(
      (error: unknown) => isServiceError(error),
    );

    // Still held, still live, still running.
    const live = await prisma.assignment.findUniqueOrThrow({ where: { id: liveId } });
    expect(live.releasedAt).toBeNull();
    expect(live.liveness).toBe("running");

    // And nothing was released behind the refusal.
    expect(await prisma.event.count({ where: { itemId, type: "release" } })).toBe(0);
  });

  it("does NOT evict a holder that never heartbeats but is making tool calls", async () => {
    // The realistic live builder in *this* deployment: it claimed half an
    // hour ago, has never called `heartbeat` — nothing tells it to — and is
    // plainly working, because its hook is spooling tool calls.
    //
    // Reading `lastActive` alone would evict it. This is the case that
    // makes the tool-call signal load-bearing rather than decorative: drop
    // it from the query or from the max and this test fails while every
    // other case here still passes.
    const itemId = await seedItem();
    const workingId = await seedHolder(itemId, "session-working", 1_800);
    await prisma.toolCall.create({
      data: { sessionId: "session-working", tool: "Bash", ts: new Date(Date.now() - 5_000) },
    });

    await expect(
      runtimeEvictingAfter(600).call("claim", contendingClaim(itemId)),
    ).rejects.toSatisfy((error: unknown) => isServiceError(error));

    const working = await prisma.assignment.findUniqueOrThrow({ where: { id: workingId } });
    expect(working.releasedAt).toBeNull();
  });

  it("does NOT evict a working holder whose only signal is a REAL telemetry flush", async () => {
    // The end-to-end version of the case above, and the one that proves the
    // liveness fix rather than assuming it. Every other test here seeds
    // `ToolCall` rows by hand, which demonstrates that eviction *reads* the
    // second signal but says nothing about whether anything ever *writes*
    // one. This drives the actual ingest — `record_tool_calls`, the
    // operation the hook's spool flushes into — and then contends.
    //
    // The holder is seeded quiet for an hour and the threshold set to 600s,
    // so it is comfortably evictable on arrival. What saves it is the flush
    // alone. Remove the `lastActive` stamp from `record_tool_calls` and
    // this fails, because the batch then leaves the assignment untouched.
    const itemId = await seedItem();
    const holderId = await seedHolder(itemId, "session-flushing", 3_600);

    const before = await prisma.assignment.findUniqueOrThrow({ where: { id: holderId } });
    expect(before.lastActive.getTime()).toBe(before.claimedAt.getTime());

    await runtimeEvictingAfter(600).call("record_tool_calls", {
      sessionId: "session-flushing",
      // An hour-old `ts`, deliberately: the flush is what proves liveness,
      // not the age of the calls inside it. A stamp taking the caller's
      // timestamp would leave this holder looking an hour quiet and it
      // would be evicted below.
      calls: [{ tool: "Bash", ts: new Date(Date.now() - 3_600_000).toISOString() }],
    });

    await expect(
      runtimeEvictingAfter(600).call("claim", contendingClaim(itemId)),
    ).rejects.toSatisfy((error: unknown) => isServiceError(error));

    const after = await prisma.assignment.findUniqueOrThrow({ where: { id: holderId } });
    expect(after.releasedAt).toBeNull();
    expect(after.liveness).toBe("running");
    expect(after.lastActive.getTime()).toBeGreaterThan(after.claimedAt.getTime());
    expect(await prisma.event.count({ where: { itemId, type: "release" } })).toBe(0);
  });

  it("leaves the original refusal intact when nothing is stale enough to take", async () => {
    // The refusal a caller acts on is "who holds this and under which
    // rule". A message about eviction instead would send the caller to fix
    // the wrong thing — and `takeover` is the documented next step, which
    // the error raised by the holder's own rule already points at.
    const itemId = await seedItem();
    await seedHolder(itemId, "session-live", 10);

    const error = await runtime()
      .call("claim", contendingClaim(itemId))
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(isServiceError(error)).toBe(true);
    // The crew guard is what refuses a second crew claiming alongside, and
    // its message names the holder.
    expect(String((error as { message: string }).message)).toContain("session-live");
  });

  it("reports no evictions on an uncontended claim", async () => {
    // The ordinary path: nothing held the item, so nothing was judged and
    // nothing was released. Asserted so `evicted` is known to be empty
    // rather than merely usually empty — a caller reading it to decide
    // whether to warn about a displaced agent needs it to mean something.
    const itemId = await seedItem();

    const result = (await runtime().call("claim", contendingClaim(itemId))) as unknown as {
      evicted: unknown[];
    };

    expect(result.evicted).toEqual([]);
    expect(await prisma.event.count({ where: { itemId, type: "release" } })).toBe(0);
  });

  it("evicts only the stale holders, leaving a live crewmate on the same item alone", async () => {
    // An item can carry several live assignments — an orchestrator plus a
    // builder. The eviction pass judges each row on its own evidence, so a
    // crew whose orchestrator died but whose builder is still working must
    // lose only the orchestrator.
    //
    // A mutant that releases every live row once *any* row is evictable
    // passes every single-holder case above and fails here.
    const itemId = await seedItem();
    const deadId = await seedHolder(itemId, "session-crew", 10_000, "orchestrator");
    const busyId = await prisma.assignment
      .create({
        data: {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: "holder-c",
          sessionId: "session-crew-builder",
          rootSessionId: "session-crew",
          machine: "laptop",
          claimedAt: new Date(Date.now() - 10_000_000),
          lastActive: new Date(Date.now() - 5_000),
        },
      })
      .then((row) => row.id);

    // The claim is still refused, and that is correct: the live builder
    // belongs to the other crew, so the crew guard refuses the newcomer
    // even once the dead orchestrator is gone. Eviction frees what the
    // evidence says is free; it does not force a claim through.
    await expect(runtimeEvictingAfter(60).call("claim", contendingClaim(itemId))).rejects.toSatisfy(
      (error: unknown) => isServiceError(error),
    );

    // **And because the claim failed, the eviction is rolled back with it.**
    // The operation runs in one transaction, so a refused claim undoes the
    // release it attempted. That is the conservative direction and worth
    // pinning: an eviction only persists when it actually handed the item to
    // somebody, so a claim that was going to be refused anyway cannot leave
    // a crew one member short as a side effect of having been attempted.
    const dead = await prisma.assignment.findUniqueOrThrow({ where: { id: deadId } });
    expect(dead.releasedAt).toBeNull();

    const busy = await prisma.assignment.findUniqueOrThrow({ where: { id: busyId } });
    expect(busy.releasedAt).toBeNull();
    expect(busy.liveness).toBe("running");

    // Nothing was recorded either — the ledger and the rows agree.
    expect(await prisma.event.count({ where: { itemId, type: "release" } })).toBe(0);
  });

  it("evicts only the stale holder when a live crewmate is on a DIFFERENT item", async () => {
    // The selectivity property on its own, without the crew guard blocking
    // the retry. The eviction pass judges each row on its own evidence, so
    // a mutant that releases every live row once *any* row is evictable
    // fails here while passing every single-holder case above.
    const strandedItem = await seedItem();
    const otherItem = await seedItem();
    const strandedId = await seedHolder(strandedItem, "session-stranded", 10_000);
    const busyId = await seedHolder(otherItem, "session-busy", 5);

    await runtimeEvictingAfter(60).call("claim", contendingClaim(strandedItem));

    const stranded = await prisma.assignment.findUniqueOrThrow({ where: { id: strandedId } });
    expect(stranded.releasedAt).not.toBeNull();

    // Untouched: eviction is scoped to the contended item, so a stale claim
    // elsewhere is not collateral of somebody claiming here.
    const busy = await prisma.assignment.findUniqueOrThrow({ where: { id: busyId } });
    expect(busy.releasedAt).toBeNull();
  });

  it("evicts the stale row and leaves a live one on the same item, when the crew allows the claim", async () => {
    // Same-item selectivity, arranged so the retry can actually succeed:
    // the live holder shares the newcomer's root session, so the crew guard
    // permits the claim and the transaction commits. This is what proves
    // per-row judgement survives to the database rather than only being
    // computed and then rolled back.
    const itemId = await seedItem();
    const strandedId = await seedHolder(itemId, "session-stranded", 10_000, "orchestrator");
    const mateId = await prisma.assignment
      .create({
        data: {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: "holder-c",
          sessionId: "session-mate",
          // Same root as the claiming session below, so this is one crew.
          rootSessionId: "session-newcomer",
          machine: "laptop",
          claimedAt: new Date(Date.now() - 10_000_000),
          lastActive: new Date(Date.now() - 5_000),
        },
      })
      .then((row) => row.id);

    const result = (await runtimeEvictingAfter(60).call("claim", {
      ...contendingClaim(itemId),
      rootSessionId: "session-newcomer",
    })) as unknown as { evicted: { assignmentId: string }[] };

    expect(result.evicted.map((e) => e.assignmentId)).toEqual([strandedId]);

    const stranded = await prisma.assignment.findUniqueOrThrow({ where: { id: strandedId } });
    expect(stranded.releasedAt).not.toBeNull();

    const mate = await prisma.assignment.findUniqueOrThrow({ where: { id: mateId } });
    expect(mate.releasedAt).toBeNull();
    expect(mate.liveness).toBe("running");
  });

  /**
   * `FOR UPDATE OF a` — the row lock that serialises a holder's heartbeat
   * against the judge-then-release window.
   *
   * **Why this direction works when the obvious one does not.** The earlier
   * attempt (recorded in the module, and the reason this was left untested)
   * raced a heartbeat *inward* — starting eviction, then firing a competing
   * statement at it. That cannot reach the window: the racing statement can
   * only land once `evictStaleHolders` has returned, by which point the
   * release `UPDATE` holds a row lock of its own, so the racer blocks with
   * or without `FOR UPDATE`. It measured the write lock and reported it as
   * the read lock.
   *
   * This races the *other way*. A competing transaction takes the row lock
   * **first** and holds it; only then does eviction run. Now the question
   * is entirely about eviction's own read: a locking read must wait for the
   * holder to commit, and a plain `SELECT` reads straight through it under
   * Read Committed. That is observable from outside the function, with no
   * seam, no test-only hook and no change to production shape — so the
   * "restructure or accept it untested" choice this row was raised to make
   * turns out not to be forced.
   *
   * **The holder here is deliberately NOT evictable, and that is the whole
   * trick.** This was measured, not assumed: with a *stale* holder the test
   * passes with and without the lock, because the judgement says "evict",
   * the release `UPDATE` runs, and *that* statement blocks on the rival's
   * lock — 1211ms unlocked versus 1219ms locked, indistinguishable. It
   * would have been the previous attempt's mistake wearing a new shape,
   * measuring the write lock again. With a live holder the judgement
   * returns `recently_seen`, no `UPDATE` is ever issued, and the read is
   * the only statement that can touch the row: 2ms unlocked versus a
   * timeout locked. So the assertion below is about `FOR UPDATE OF a` and
   * nothing else.
   *
   * `lock_timeout` turns the wait into a definite, fast failure rather than
   * a sleep: with the lock the statement is cancelled by Postgres, without
   * it the read completes immediately. No fixed sleep, no polling of
   * `pg_stat_activity`, and the assertion is on which of those two happened.
   */
  it("takes a ROW LOCK on its read, so a concurrent writer serialises against it", async () => {
    const itemId = await seedItem();
    // Quiet for 5s against a 60s threshold below — live, so nothing is
    // released and the read stands alone. See the note above.
    const holderId = await seedHolder(itemId, "session-locked", 5);

    // A second connection: the lock has to be held by a genuinely
    // concurrent transaction, and Prisma's interactive transaction runs on
    // one connection from its own pool.
    const rival = new PrismaClient({ datasourceUrl: scratchUrl });
    let releaseRival: () => void = () => {};
    const rivalMayFinish = new Promise<void>((resolve) => (releaseRival = resolve));
    let rivalHasLock: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => (rivalHasLock = resolve));

    const rivalTx = rival.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "Assignment" WHERE "id" = $1 FOR UPDATE`,
        holderId,
      );
      rivalHasLock();
      await rivalMayFinish;
    });

    try {
      await lockTaken;

      let blocked = false;
      try {
        await prisma.$transaction(async (tx) => {
          // Short, so a genuine block fails fast instead of hanging the
          // suite. Postgres cancels the statement; it does not return rows.
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
          await evictStaleHolders(tx as never, {
            itemId,
            evictAfterSeconds: 60,
            bySessionId: "session-newcomer",
          });
        });
      } catch (error) {
        // 55P03 lock_not_available / "canceling statement due to lock
        // timeout" — the read waited, which is the property under test.
        blocked = /lock timeout|55P03|canceling statement/i.test(String(error));
      }

      // **This is the assertion that dies when `FOR UPDATE OF a` is
      // removed.** Without the lock the read passes straight through the
      // rival's uncommitted row and the eviction completes in milliseconds.
      expect(blocked).toBe(true);

      // And nothing was released while blocked — the judgement never ran.
      const held = await prisma.assignment.findUniqueOrThrow({ where: { id: holderId } });
      expect(held.releasedAt).toBeNull();
    } finally {
      releaseRival();
      await rivalTx;
      await rival.$disconnect();
    }
  });
});
