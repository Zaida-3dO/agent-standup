// The approved-but-unmerged finding — the pure predicate, tested at its
// boundaries, plus the `my_work` wiring against a real Postgres.
//
// Split the way `liveness.ts`/`claim-eviction.ts` are split, and for the
// reason those files state: "every interesting case is a boundary, and a
// boundary tested through a database is tested by whatever `now` the test
// happened to construct". `findStalledWork` takes `now` as a parameter
// precisely so "at the threshold nothing fires, one second past it does"
// can be asserted exactly rather than approximately.
//
// **The quiet case is tested as hard as the loud one, on purpose.** A
// signal that fires on everything is worse than none, because readers learn
// to skip it — so every reason this must stay silent (no approval, a fresh
// approval, an approval exactly on the threshold, a merged item, a
// cancelled item) gets its own named assertion rather than being assumed.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import {
  describeDuration,
  findStalledWork,
  isClosedState,
  type ApprovalFacts,
  type StalledWorkFinding,
} from "@/lib/service/operations/stalled-work";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const NOW = new Date("2026-09-02T12:00:00.000Z");
const THRESHOLD = 1800;

/** An approval `seconds` before `NOW`. */
function approvedSecondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function fact(overrides: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    itemId: "item-1",
    title: "A reviewed change",
    state: "in_review",
    approvedAt: approvedSecondsAgo(THRESHOLD + 1),
    ...overrides,
  };
}

describe("findStalledWork — the predicate", () => {
  describe("fires when work was approved and left unmerged", () => {
    it("reports an approval older than the threshold", () => {
      // The whole point of the feature: reviewed work that stopped moving.
      const findings = findStalledWork([fact()], THRESHOLD, NOW);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.itemId).toBe("item-1");
      expect(findings[0]!.title).toBe("A reviewed change");
      expect(findings[0]!.state).toBe("in_review");
    });

    it("reports how long it has waited, in whole seconds", () => {
      // A mutant returning a constant, or dropping the arithmetic, fails
      // here — `waitingSeconds` is the field that answers "how long has it
      // waited", which is half of what the caller asked for.
      const findings = findStalledWork(
        [fact({ approvedAt: approvedSecondsAgo(7200) })],
        THRESHOLD,
        NOW,
      );

      expect(findings[0]!.waitingSeconds).toBe(7200);
    });

    it("reports the approval's own timestamp, not the time of the read", () => {
      const approvedAt = approvedSecondsAgo(7200);
      const findings = findStalledWork([fact({ approvedAt })], THRESHOLD, NOW);

      expect(findings[0]!.approvedAt).toBe(approvedAt.toISOString());
    });

    it("says in the message that nits and follow-ups are approvals that merge now", () => {
      // The single most expensive misreading in the field reports: a
      // reviewer returned an approval with minor follow-ups and the session
      // read it as "not finished yet", so four branches sat parked. The
      // message has to say plainly that it is a merge plus new rows.
      const message = findStalledWork([fact()], THRESHOLD, NOW)[0]!.message;

      expect(message).toContain("lgtm_with_nits");
      expect(message).toContain("lgtm_with_followups");
      expect(message).toContain("merge now");
    });

    it("fires for every state that is not closed, including executing", () => {
      // An item approved while still `executing` is exactly as stalled as
      // one in `in_review`; gating on a single state would miss it.
      const findings = findStalledWork(
        [
          fact({ itemId: "a", state: "in_review" }),
          fact({ itemId: "b", state: "executing" }),
          fact({ itemId: "c", state: "blocked" }),
        ],
        THRESHOLD,
        NOW,
      );

      expect(findings.map((f) => f.itemId)).toEqual(["a", "b", "c"]);
    });
  });

  // ── The quiet case. Every one of these is a way the signal could become
  // noise, and noise is the failure mode that makes the whole feature
  // worthless rather than merely incomplete.
  describe("stays silent when nothing has stopped moving", () => {
    it("says nothing about an item with no approving review at all", () => {
      // The overwhelmingly common row: work nobody has reviewed yet. It is
      // earlier in its life, not stalled.
      expect(findStalledWork([fact({ approvedAt: null })], THRESHOLD, NOW)).toEqual([]);
    });

    it("says nothing about an approval recorded seconds ago", () => {
      // The session that just recorded this approval is the least likely
      // party in the system to have forgotten it. Firing here would put a
      // line on the response of the call that was doing the right thing.
      expect(
        findStalledWork([fact({ approvedAt: approvedSecondsAgo(5) })], THRESHOLD, NOW),
      ).toEqual([]);
    });

    it("says nothing at exactly the threshold", () => {
      // The boundary falls on the quiet side. A mutant flipping `<=` to `<`
      // fires here and dies on this assertion.
      expect(
        findStalledWork([fact({ approvedAt: approvedSecondsAgo(THRESHOLD) })], THRESHOLD, NOW),
      ).toEqual([]);
    });

    it("fires one second past the threshold", () => {
      // The other half of the boundary. Together these two pin the
      // comparison to a single second — the assertion pair that makes a
      // mutated threshold or a flipped operator unmissable.
      expect(
        findStalledWork([fact({ approvedAt: approvedSecondsAgo(THRESHOLD + 1) })], THRESHOLD, NOW),
      ).toHaveLength(1);
    });

    it("says nothing about a merged item, however long ago it was approved", () => {
      // The work landed. This is the success case, and it is the one that
      // would otherwise fire forever on every completed row the session
      // still holds.
      expect(
        findStalledWork(
          [fact({ state: "merged", approvedAt: approvedSecondsAgo(86_400 * 30) })],
          THRESHOLD,
          NOW,
        ),
      ).toEqual([]);
    });

    it("says nothing about work that was abandoned", () => {
      // `wont_do` and `cancelled` are decisions, not omissions. Nudging
      // toward merging something deliberately dropped is the clearest way
      // to teach a reader to ignore the field.
      const findings = findStalledWork(
        [
          fact({ itemId: "a", state: "wont_do", approvedAt: approvedSecondsAgo(86_400) }),
          fact({ itemId: "b", state: "cancelled", approvedAt: approvedSecondsAgo(86_400) }),
        ],
        THRESHOLD,
        NOW,
      );

      expect(findings).toEqual([]);
    });

    it("returns an empty list for a session holding nothing", () => {
      expect(findStalledWork([], THRESHOLD, NOW)).toEqual([]);
    });

    it("reports only the stalled rows out of a mixed set", () => {
      // The realistic shape: a session holding several things, most of them
      // healthy. A predicate that fired on all four would be indistinguish-
      // able from one that fired on none, from the reader's point of view.
      const findings = findStalledWork(
        [
          fact({ itemId: "stalled", approvedAt: approvedSecondsAgo(THRESHOLD + 60) }),
          fact({ itemId: "fresh", approvedAt: approvedSecondsAgo(10) }),
          fact({ itemId: "unreviewed", approvedAt: null }),
          fact({ itemId: "landed", state: "merged", approvedAt: approvedSecondsAgo(86_400) }),
        ],
        THRESHOLD,
        NOW,
      );

      expect(findings.map((f) => f.itemId)).toEqual(["stalled"]);
    });
  });

  describe("isClosedState", () => {
    it("treats merged, wont_do and cancelled as closed", () => {
      expect(["merged", "wont_do", "cancelled"].map(isClosedState)).toEqual([true, true, true]);
    });

    it("treats live states as open", () => {
      // `paused` and `blocked` are deliberately open: work that is waiting
      // on something is still work, and an approval sitting on it is still
      // an approval nobody acted on.
      expect(["in_review", "executing", "on_deck", "paused", "blocked"].map(isClosedState)).toEqual(
        [false, false, false, false, false],
      );
    });
  });
});

describe("describeDuration — the unit a reader acts on", () => {
  it("uses seconds below a minute", () => {
    expect(describeDuration(45)).toBe("45 seconds");
  });

  it("uses minutes below an hour", () => {
    expect(describeDuration(3599)).toBe("59 minutes");
  });

  it("uses hours below a day", () => {
    expect(describeDuration(7200)).toBe("2 hours");
  });

  it("uses days beyond that", () => {
    expect(describeDuration(86_400 * 3)).toBe("3 days");
  });

  it("singularises exactly one unit", () => {
    // A mutant dropping the plural branch passes every assertion above and
    // dies here.
    expect(describeDuration(3600)).toBe("1 hour");
    expect(describeDuration(1)).toBe("1 second");
  });
});

describeIfDb("my_work reports stalled work against Postgres", () => {
  const dbName = scratchDatabaseName("stalled_work");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function makeItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return (await runtime.call("create_item", {
      title: "stalled-work subject",
      body: "x",
      area: "stalled-work-area",
      originType: "auto",
      ...overrides,
    })) as { id: string };
  }

  async function claim(input: ClaimInput) {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  /**
   * An approving review artifact, written directly with a chosen
   * `createdAt`.
   *
   * Direct rather than through `record_artifact` because the age is the
   * whole subject: the operation stamps `now()`, which can only ever
   * produce a fresh approval, and a fresh approval is precisely the case
   * that must NOT fire.
   */
  async function approve(
    itemId: string,
    opts: { verdict?: string; secondsAgo?: number } = {},
  ): Promise<void> {
    const { verdict = "lgtm", secondsAgo = 7200 } = opts;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Artifact"
         ("id", "itemId", "kind", "verdict", "createdByType", "createdById", "createdAt")
       VALUES (gen_random_uuid(), $1, 'code_review', $2::"Verdict", 'agent', 'reviewer-1',
               now() - ($3 || ' seconds')::interval)`,
      itemId,
      verdict,
      String(secondsAgo),
    );
  }

  async function stalledFor(sessionId: string): Promise<readonly StalledWorkFinding[]> {
    const result = (await runtime.call("my_work", { sessionId })) as {
      stalledWork: readonly StalledWorkFinding[];
    };
    return result.stalledWork;
  }

  it("reports an item this session holds that was approved and never merged", async () => {
    const item = await makeItem({ title: "Approved and parked" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-parked",
      machine: "laptop",
    });
    await approve(item.id);

    const stalled = await stalledFor("session-parked");

    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.itemId).toBe(item.id);
    expect(stalled[0]!.title).toBe("Approved and parked");
    // Roughly two hours, allowing for the seconds the test itself takes.
    expect(stalled[0]!.waitingSeconds).toBeGreaterThanOrEqual(7200);
    expect(stalled[0]!.waitingSeconds).toBeLessThan(7260);
  });

  it("counts lgtm_with_nits as an approval", async () => {
    // The verdict the field reports misread as "not finished yet". If this
    // did not fire, the feature would miss the exact case it was built for.
    const item = await makeItem({ title: "Approved with nits" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-nits",
      machine: "laptop",
    });
    await approve(item.id, { verdict: "lgtm_with_nits" });

    expect(await stalledFor("session-nits")).toHaveLength(1);
  });

  it("counts lgtm_with_followups as an approval", async () => {
    const item = await makeItem({ title: "Approved with follow-ups" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-followups",
      machine: "laptop",
    });
    await approve(item.id, { verdict: "lgtm_with_followups" });

    expect(await stalledFor("session-followups")).toHaveLength(1);
  });

  it("says nothing about a rejected review", async () => {
    // `changes_required` is not an approval, so there is nothing waiting to
    // be merged. A mutant reading any review as approving dies here.
    const item = await makeItem({ title: "Changes required" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-rejected",
      machine: "laptop",
    });
    await approve(item.id, { verdict: "changes_required" });

    expect(await stalledFor("session-rejected")).toEqual([]);
  });

  it("says nothing about a `na` verdict, which reviews nothing", async () => {
    // `na` means "this artifact kind has no verdict to give". Reading it as
    // a pass is the mistake `verdicts.ts` calls out by name.
    const item = await makeItem({ title: "Not applicable" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-na",
      machine: "laptop",
    });
    await approve(item.id, { verdict: "na" });

    expect(await stalledFor("session-na")).toEqual([]);
  });

  it("says nothing about a freshly approved item", async () => {
    // The quiet case that matters most, end to end: the approval exists,
    // the item is unmerged, and it is still too new to be a finding.
    const item = await makeItem({ title: "Just approved" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-fresh",
      machine: "laptop",
    });
    await approve(item.id, { secondsAgo: 5 });

    expect(await stalledFor("session-fresh")).toEqual([]);
  });

  it("says nothing about a session holding healthy, unreviewed work", async () => {
    // The ordinary session. This is the assertion that proves the field is
    // quiet by default rather than quiet by accident.
    const item = await makeItem({ title: "In progress" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-healthy",
      machine: "laptop",
    });

    expect(await stalledFor("session-healthy")).toEqual([]);
  });

  it("says nothing to a session holding nothing at all", async () => {
    expect(await stalledFor("session-holds-nothing")).toEqual([]);
  });

  it("does not report another session's approved work", async () => {
    // The scoping property. `my_work` answers "what do I hold", so a finding
    // that leaked across sessions would be reporting somebody else's
    // problem — and would fire on every session in the installation.
    const item = await makeItem({ title: "Someone else's parked work" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-owner",
      machine: "laptop",
    });
    await approve(item.id);

    expect(await stalledFor("session-owner")).toHaveLength(1);
    expect(await stalledFor("session-bystander")).toEqual([]);
  });

  it("stops reporting once the item is released", async () => {
    // A released claim is somebody else's to pick up, so it is outside what
    // this session holds. Without this, a session would keep being told
    // about every item it ever touched.
    const item = await makeItem({ title: "Handed back" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-released",
      machine: "laptop",
    });
    await approve(item.id);
    expect(await stalledFor("session-released")).toHaveLength(1);

    await prisma.$executeRawUnsafe(
      `UPDATE "Assignment" SET "releasedAt" = now() WHERE "sessionId" = $1`,
      "session-released",
    );

    expect(await stalledFor("session-released")).toEqual([]);
  });

  it("measures from the newest approval when a re-review happened", async () => {
    // A second approving round is newer evidence. Taking the oldest would
    // report an item re-approved a minute ago as having waited since the
    // first round — which is both wrong and the direction that produces
    // noise.
    const item = await makeItem({ title: "Re-reviewed" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-1",
      sessionId: "session-rereviewed",
      machine: "laptop",
    });
    await approve(item.id, { secondsAgo: 86_400 });
    await approve(item.id, { secondsAgo: 10 });

    expect(await stalledFor("session-rereviewed")).toEqual([]);
  });
});
