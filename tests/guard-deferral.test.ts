// Guard — deferral proof: a `not_done` entry reasoned `follow-up` or
// `needs-approval` must name a real item that is genuinely blocked (or
// paused, for `follow-up`), not merely asserted to be. See
// docs/plans/MILESTONES.md #22, SCHEMA.md §5a.
//
// Runs against a real Postgres, like `guard-hierarchy.test.ts` and
// `summaries-guard.test.ts` — AC3 ("that follow-up is genuinely blocked") is
// a claim about a row actually written and then read back, which an
// in-memory model cannot settle. Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFERRAL_FOLLOW_UP_GUARD_ID,
  DEFERRAL_REASONS_REQUIRING_ITEM,
  GuardRegistry,
  applyTransition,
  deferralFollowUpGuard,
  rehearseTransition,
} from "@/lib/service";
import type { GuardInput } from "@/lib/service";
import { NOT_DONE_REASONS } from "@/lib/service/summaries";
import { defaultSnapshot } from "@/lib/settings";
import type { TransactionHandle } from "@/lib/service";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the deferral-proof guard, against Postgres", () => {
  const dbName = scratchDatabaseName("guard_deferral");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.person.createMany({
      data: [
        { id: "user-a", displayName: "user-a" },
        { id: "user-b", displayName: "user-b" },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function createItem(opts: {
    state: string;
    id?: string;
    blockedOnType?: "person" | "external_process" | "time" | null;
    blockedOnPersonId?: string | null;
  }): Promise<string> {
    counter += 1;
    const id = opts.id ?? `task-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: opts.state as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
        blockedReason: opts.blockedOnType ? "waiting" : null,
        blockedOnType: (opts.blockedOnType ?? null) as never,
        blockedOnPersonId: opts.blockedOnPersonId ?? null,
      },
    });
    return id;
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  /** Minimal `ServiceContext`-shaped db handle over the raw Prisma client — no operation/runtime plumbing needed for guard-level tests. */
  function dbHandle(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  function newCtx() {
    return {
      db: dbHandle(),
      settings: defaultSnapshot(),
      caller: {},
      operation: "test",
    };
  }

  function transition(itemId: string, to: string, fields?: Record<string, unknown>) {
    const reg = new GuardRegistry();
    reg.register(deferralFollowUpGuard);
    return applyTransition(newCtx(), { itemId, to, fields }, reg);
  }

  function rehearse(itemId: string, to: string, fields?: Record<string, unknown>) {
    const reg = new GuardRegistry();
    reg.register(deferralFollowUpGuard);
    return rehearseTransition(newCtx(), { itemId, to, fields }, reg);
  }

  function summaryWith(notDone: unknown[]) {
    return { summary: { not_done: notDone } };
  }

  describe("AC1 — typed reasons from a closed set", () => {
    it("the guard's own closed set of reasons it dereferences is a SUBSET of NOT_DONE_REASONS — never a reason NOT_DONE_REASONS itself refuses", () => {
      // `validateSummaryShape` (row #21) is what actually refuses an
      // unlisted reason string outright — this guard never even sees an
      // entry that failed that check, because the summary guard runs first
      // in a real transition-and-complete call and rejects before this
      // guard's check body would run. What this guard's OWN test can prove
      // in isolation is narrower and just as load-bearing: every reason
      // string this guard treats as "needs a linked item" is one of the
      // three SCHEMA.md §5a actually defines, not an invented fourth one.
      for (const reason of DEFERRAL_REASONS_REQUIRING_ITEM) {
        expect(NOT_DONE_REASONS as readonly string[]).toContain(reason);
      }
    });

    it("refused case — an entry reasoned 'follow-up' with no item_id at all is rejected, not silently accepted", async () => {
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([{ text: "x", reason: "follow-up" }]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      expect(await readState(id)).toBe("executing");
    });

    it("a 'descoped' entry needs no item_id at all and is accepted with none supplied", async () => {
      const id = await createItem({ state: "executing" });
      await transition(id, "merged", summaryWith([{ text: "not doing it", reason: "descoped" }]));
      expect(await readState(id)).toBe("merged");
    });
  });

  describe("AC2 — a deferral creates (names) a follow-up item", () => {
    it("an entry reasoned 'follow-up' pointing at a real, blocked item is accepted", async () => {
      const followUp = await createItem({ state: "blocked", blockedOnType: "person" });
      const id = await createItem({ state: "executing" });
      await transition(
        id,
        "merged",
        summaryWith([{ text: "ship the rest", reason: "follow-up", item_id: followUp }]),
      );
      expect(await readState(id)).toBe("merged");
    });

    it("an entry naming an item_id that does not exist at all is rejected", async () => {
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([{ text: "x", reason: "follow-up", item_id: "no-such-item" }]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("AC3 — that follow-up is genuinely blocked (queried, not asserted)", () => {
    it("rejects when the linked follow-up item is actionable (on_deck) — the load-bearing case", async () => {
      const followUp = await createItem({ state: "on_deck" }); // freshly minted, actionable — exactly what create_item produces
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([{ text: "do it later", reason: "follow-up", item_id: followUp }]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      // Query the follow-up's OWN state after the rejection — it must still
      // be exactly what it was, proving this guard's rejection is decided
      // by reading real state, not by trusting the caller's claim.
      expect(await readState(followUp)).toBe("on_deck");
      expect(await readState(id)).toBe("executing");
    });

    it("accepts when the linked follow-up is paused — SCHEMA.md §5a's 'not actionable' set includes paused, not just blocked", async () => {
      const followUp = await createItem({ state: "paused" });
      const id = await createItem({ state: "executing" });
      await transition(
        id,
        "merged",
        summaryWith([{ text: "later", reason: "follow-up", item_id: followUp }]),
      );
      expect(await readState(id)).toBe("merged");
      // The follow-up's actual state, queried, is what makes this pass —
      // not a return value the guard merely reported.
      expect(await readState(followUp)).toBe("paused");
    });

    it("does not fire on a non-completed target — the transition succeeds with an actionable follow-up, because appliesTo is false", async () => {
      const followUp = await createItem({ state: "on_deck" });
      const id = await createItem({ state: "executing" });
      await transition(
        id,
        "in_review",
        summaryWith([{ text: "later", reason: "follow-up", item_id: followUp }]),
      );
      expect(await readState(id)).toBe("in_review");
    });

    it("rehearsal reports the rejection without writing anything, and the follow-up's queried state is unchanged", async () => {
      const followUp = await createItem({ state: "executing" });
      const id = await createItem({ state: "executing" });
      const outcome = await rehearse(
        id,
        "merged",
        summaryWith([{ text: "later", reason: "follow-up", item_id: followUp }]),
      );
      expect(outcome.allowed).toBe(false);
      expect(outcome.rejection?.guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      expect(await readState(id)).toBe("executing");
      expect(await readState(followUp)).toBe("executing");
    });
  });

  describe("needs-approval — a sharper case than 'follow-up': blocked is not enough on its own", () => {
    it("accepts when the linked item is blocked with blocked_on_type=person", async () => {
      const approvalItem = await createItem({
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: "user-a",
      });
      const id = await createItem({ state: "executing" });
      await transition(
        id,
        "merged",
        summaryWith([
          { text: "waiting on sign-off", reason: "needs-approval", item_id: approvalItem },
        ]),
      );
      expect(await readState(id)).toBe("merged");
    });

    it("rejects when the linked item is blocked but on external_process, not a person — 'blocked' alone is not enough", async () => {
      const blockedOnProcess = await createItem({
        state: "blocked",
        blockedOnType: "external_process",
      });
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([
          { text: "waiting on sign-off", reason: "needs-approval", item_id: blockedOnProcess },
        ]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      // Read the linked item's own type back, proving the rejection came
      // from the real stored value, not an assumption.
      const row = await prisma.item.findUniqueOrThrow({ where: { id: blockedOnProcess } });
      expect(row.blockedOnType).toBe("external_process");
      expect(await readState(id)).toBe("executing");
    });

    it("rejects when the linked item is merely paused, not blocked — 'needs-approval' is stricter than 'follow-up'", async () => {
      // The near-miss this guard must NOT treat as equivalent: `paused`
      // satisfies `follow-up`'s "not actionable" test but explicitly fails
      // `needs-approval`'s narrower "blocked on a person" test.
      const paused = await createItem({ state: "paused" });
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([{ text: "waiting", reason: "needs-approval", item_id: paused }]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe(DEFERRAL_FOLLOW_UP_GUARD_ID);
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("what this guard's reason-matching does not see — casing, near-misses, cross-entity confusion", () => {
    it("does NOT recognise a differently-cased reason as one of the two it dereferences ('Follow-Up' is not 'follow-up')", async () => {
      // A mis-cased reason is not one of NOT_DONE_REASONS at all, so row
      // #21's shape guard would refuse it — but proven here in isolation:
      // this guard's own set-membership test is exact-string, not
      // case-insensitive, so it would not accidentally treat a mis-cased
      // near-miss as needing an item lookup it then can't perform sensibly.
      const id = await createItem({ state: "executing" });
      const input: GuardInput = {
        item: {
          id,
          kind: "task",
          state: "executing",
          blockedReason: null,
          blockedOnType: null,
          blockedOnPersonId: null,
          unblockAt: null,
          pauseReason: null,
          resumeCondition: null,
          needsVisualReview: false,
          mergeAuthority: "needs_approval",
        },
        from: "executing",
        to: "merged",
        fields: summaryWith([{ text: "x", reason: "Follow-Up" }]),
        db: dbHandle(),
        settings: defaultSnapshot(),
      };
      const result = await deferralFollowUpGuard.check(input);
      // Not this guard's problem to raise — it has nothing to say about a
      // reason outside its own closed set, so it passes THROUGH (ok), which
      // is correct: `validateSummaryShape` is the guard responsible for
      // refusing the mis-cased string itself, in a real end-to-end call
      // where both guards run.
      expect(result.ok).toBe(true);
    });

    it("a near-miss reason string ('followup', no hyphen) is not recognised — this guard requires the exact SCHEMA.md spelling", async () => {
      const id = await createItem({ state: "executing" });
      const input: GuardInput = {
        item: {
          id,
          kind: "task",
          state: "executing",
          blockedReason: null,
          blockedOnType: null,
          blockedOnPersonId: null,
          unblockAt: null,
          pauseReason: null,
          resumeCondition: null,
          needsVisualReview: false,
          mergeAuthority: "needs_approval",
        },
        from: "executing",
        to: "merged",
        fields: summaryWith([{ text: "x", reason: "followup" }]),
        db: dbHandle(),
        settings: defaultSnapshot(),
      };
      const result = await deferralFollowUpGuard.check(input);
      expect(result.ok).toBe(true);
    });

    it("multiple not_done entries — the rejection identifies WHICH entry failed, not just that one did", async () => {
      const goodFollowUp = await createItem({
        state: "blocked",
        blockedOnType: "external_process",
      });
      const id = await createItem({ state: "executing" });
      const error = await transition(
        id,
        "merged",
        summaryWith([
          { text: "fine", reason: "follow-up", item_id: goodFollowUp },
          { text: "bad", reason: "follow-up", item_id: "does-not-exist" },
        ]),
      ).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { fields?: string[] }).fields).toContain("not_done[1].item_id");
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("registration — the canonical way, a literal namespaced id", () => {
    it("is retrievable from a GuardRegistry by its own id, and applicable only to entering a completed state", () => {
      const reg = new GuardRegistry();
      reg.register(deferralFollowUpGuard);
      expect(reg.has("deferral.follow_up_must_be_blocked")).toBe(true);
      for (const finishing of ["merged", "research_done", "wont_do", "cancelled"]) {
        expect(deferralFollowUpGuard.appliesTo("executing", finishing)).toBe(true);
      }
      for (const notFinishing of ["blocked", "paused", "executing", "on_deck"]) {
        expect(deferralFollowUpGuard.appliesTo("executing", notFinishing)).toBe(false);
      }
    });
  });
});
