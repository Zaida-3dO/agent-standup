// I15's occupancy query, against a real Postgres — MILESTONES.md #128,
// `docs/plans/INTERVENTIONS.md` I15.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The unit tests for `assembleContext` assert on the *text* of the query it
// builds, against a handle that answers with canned rows. That proves the
// string was written; it cannot prove the string means anything. A review
// demonstrated the gap concretely: the whole `WHERE` clause could be
// replaced with a tautology, or the parameter binding order transposed, and
// every text assertion still passed — while the entry blocked every crew
// against itself and against unrelated repositories.
//
// So the semantics are pinned here instead, by executing the real query
// against real rows. The cases are the ones the entry's own catalogue text
// argues about, and each is a way the predicate can be wrong in a direction
// nobody would notice from behaviour:
//
//   - **A crew must not block against its own orchestrator.** The comparison
//     is between root sessions, and a builder a parent spawned shares the
//     parent's root. Getting this backwards refuses the ordinary case.
//   - **A different crew in the same working tree must be found.** This
//     is the entry's whole purpose, and the binding order is what decides
//     whether the pair is even compared correctly.
//   - **A different crew in a SIBLING worktree must not be found.** The two
//     directions are one test each and neither alone proves anything: an
//     entry that fires on both is the false positive three crews hit on
//     2026-08-31, and one that fires on neither has been disabled rather
//     than fixed. Same machine, same repository, different tree.
//   - **A holder quiet past the staleness bound must not count**, however
//     `running` its row still claims to be — nothing moves a crashed claim
//     off that value.
//   - **A released or non-running holder must not count.** A finished crew's
//     claim would otherwise refuse work indefinitely.
//   - **A different machine, or a different repository, is a different
//     checkout.** Dropping either half of the pair matches everything.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/interventions/context";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("I15 occupancy — against Postgres", () => {
  const dbName = scratchDatabaseName("interventions_occupancy");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.repo.create({ data: { id: "repo-a", displayName: "repo-a" } });
    await prisma.repo.create({ data: { id: "repo-b", displayName: "repo-b" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;

  /** One item in a repository, so a claim has something to point at. */
  async function createItem(repo: string): Promise<string> {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "person",
        area: "web",
        repo,
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /**
   * The working tree both crews share unless a case says otherwise.
   *
   * An invented path — this repository is public, and a real checkout path
   * says which machine ran the suite and who owns it.
   */
  const SHARED_TREE = "/checkouts/wt-shared";

  /**
   * A live claim. Every field the predicate keys on is explicit here.
   *
   * `worktree` **defaults to the shared tree** rather than to `null`, and
   * that default is load-bearing. The entry compares working trees, so a
   * claim without one is not comparable and produces no finding at all — a
   * suite defaulting to `null` would see every case pass while asserting
   * nothing, which is how the granularity defect survived its own tests.
   * A case that wants the unknown must now ask for it by name.
   */
  async function claim(options: {
    sessionId: string;
    rootSessionId: string;
    itemId: string;
    machine: string;
    worktree?: string | null;
    branch?: string;
    liveness?: "running" | "stalled" | "dead";
    released?: boolean;
    lastActive?: Date;
  }): Promise<void> {
    await prisma.assignment.create({
      data: {
        itemId: options.itemId,
        role: "builder",
        holderType: "agent",
        holderId: options.sessionId,
        sessionId: options.sessionId,
        rootSessionId: options.rootSessionId,
        machine: options.machine,
        worktree: options.worktree === undefined ? SHARED_TREE : options.worktree,
        branch: options.branch ?? null,
        liveness: (options.liveness ?? "running") as never,
        releasedAt: options.released === true ? new Date() : null,
        ...(options.lastActive === undefined ? {} : { lastActive: options.lastActive }),
      },
    });
  }

  /** Assembles the context the way `hook_decision` does, on a file edit. */
  async function occupancyFor(sessionId: string) {
    const context = await assembleContext({
      db: prisma as never,
      sessionId,
      tool: "Edit",
    });
    return context.occupyingCrew;
  }

  it("finds another crew in the SAME working tree", async () => {
    // The entry's whole purpose, and the 2026-08-23 incident: two crews in
    // one directory cross-contaminated three PRs. Two distinct roots, one
    // machine, one repo, one tree.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      branch: "feat/x",
    });

    const holder = await occupancyFor("s-mine");
    expect(holder?.rootSessionId).toBe("root-b");
    expect(holder?.itemId).toBe(theirs);
    expect(holder?.branch).toBe("feat/x");
  });

  it("does NOT find a crew in a sibling worktree of the same repository", async () => {
    // The other direction, and the failure three crews hit on 2026-08-31.
    // Identical `(machine, repo)` to the case above and the opposite
    // verdict, which is precisely what that pair alone cannot express. This
    // is the arrangement every parallel dispatch here uses, and the one the
    // entry's own message tells a blocked crew to adopt.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({
      sessionId: "s-mine",
      rootSessionId: "root-a",
      itemId: mine,
      machine: "desktop",
      worktree: "/checkouts/wt-mine",
    });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      worktree: "/checkouts/wt-theirs",
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("matches two spellings of one working tree", async () => {
    // Normalisation is the part the original design retreated from, on the
    // sound ground that raw equality passes silently on exactly the
    // collisions it must catch. Both crews are in one directory, written
    // the way two different tools print it — slash direction, a trailing
    // separator, a `.` segment and drive-letter case. Compared raw these are
    // four different strings and the shared checkout goes unnoticed.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({
      sessionId: "s-mine",
      rootSessionId: "root-a",
      itemId: mine,
      machine: "desktop",
      worktree: "C:\\Checkouts\\WT-Shared",
    });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      worktree: "c:/checkouts/./wt-shared/",
    });

    expect((await occupancyFor("s-mine"))?.rootSessionId).toBe("root-b");
  });

  it("ignores a holder quiet for longer than the staleness bound", async () => {
    // Reported as `last active 941694s ago` — about 10.9 days — and the row
    // still said `running`, because `sweepLiveness` has no caller and the
    // claim insert is `ON CONFLICT DO NOTHING`. Without a bound one
    // abandoned claim refuses every future crew in that repository forever.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      lastActive: new Date(Date.now() - 941_694 * 1000),
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("still blocks against a holder active seconds ago in the same tree", async () => {
    // The staleness bound's other direction. A bound set too aggressively
    // would excuse a live collision, which is the failure mode of fixing
    // the stale case carelessly.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      lastActive: new Date(Date.now() - 5_000),
    });

    expect((await occupancyFor("s-mine"))?.rootSessionId).toBe("root-b");
  });

  it("ignores a holder whose claim recorded no working tree", async () => {
    // Unknown is not comparable. Reading it as "same tree" would block every
    // crew whose claim omitted an optional field — the reported failure,
    // reintroduced from the other end.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      worktree: null,
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("asks nothing when the caller's own claim recorded no working tree", async () => {
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({
      sessionId: "s-mine",
      rootSessionId: "root-a",
      itemId: mine,
      machine: "desktop",
      worktree: null,
    });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("finds the crew sharing the tree even when a sibling's claim is fresher", async () => {
    // The query orders by `lastActive` and the tree comparison happens in
    // process, so the freshest row back is often a sibling worktree.
    // Reading only the first candidate would miss the genuine collision —
    // the exact shape this repository produces, with many sibling worktrees
    // of one repository all active at once.
    const mine = await createItem("repo-a");
    const sibling = await createItem("repo-a");
    const sharer = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-sibling",
      rootSessionId: "root-sibling",
      itemId: sibling,
      machine: "desktop",
      worktree: "/checkouts/wt-elsewhere",
      lastActive: new Date(),
    });
    await claim({
      sessionId: "s-sharer",
      rootSessionId: "root-sharer",
      itemId: sharer,
      machine: "desktop",
      lastActive: new Date(Date.now() - 60_000),
    });

    expect((await occupancyFor("s-mine"))?.rootSessionId).toBe("root-sharer");
  });

  it("does not block a worker against its own orchestrator", async () => {
    // The distinction `registered_processes` established, executed rather
    // than asserted as a substring. Both sessions share a root, so they are
    // one crew and neither may refuse the other.
    const parentItem = await createItem("repo-a");
    const childItem = await createItem("repo-a");
    await claim({
      sessionId: "s-parent",
      rootSessionId: "root-shared",
      itemId: parentItem,
      machine: "desktop",
    });
    await claim({
      sessionId: "s-child",
      rootSessionId: "root-shared",
      itemId: childItem,
      machine: "desktop",
    });

    expect(await occupancyFor("s-child")).toBeUndefined();
    expect(await occupancyFor("s-parent")).toBeUndefined();
  });

  it("ignores a released claim", async () => {
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
      released: true,
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("ignores a crew that is not running", async () => {
    // A stalled or dead claim is the liveness sweep's business. Blocking on
    // one refuses work on the strength of a crew that has stopped.
    for (const liveness of ["stalled", "dead"] as const) {
      const mine = await createItem("repo-a");
      const theirs = await createItem("repo-a");
      await claim({
        sessionId: "s-mine",
        rootSessionId: "root-a",
        itemId: mine,
        machine: "desktop",
      });
      await claim({
        sessionId: "s-theirs",
        rootSessionId: "root-b",
        itemId: theirs,
        machine: "desktop",
        liveness,
      });

      expect(await occupancyFor("s-mine"), liveness).toBeUndefined();
      await prisma.assignment.deleteMany({});
      await prisma.item.deleteMany({});
    }
  });

  it("does not match a crew on a different machine", async () => {
    // Half the pair. A query that dropped it would compare every checkout
    // on every machine against this one.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "laptop",
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("does not match a crew in a different repository", async () => {
    // The other half of the pair, and the case that catches a transposed
    // parameter binding: with the machine and repository arguments swapped,
    // this case and the machine case above cannot both pass.
    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-b");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
    });

    expect(await occupancyFor("s-mine")).toBeUndefined();
  });

  it("reads the machine off the claim, with no session registration", async () => {
    // `claim` requires a machine and stores it on the assignment, and it
    // creates no `Session` row — session registration is a separate act an
    // installation need not perform. Resolving the machine through
    // `Session` therefore answers null for an ordinary claim and disables
    // the entry entirely, which is a silent negative rather than a visible
    // failure. No `Session` rows are seeded anywhere in this file, so every
    // passing case above already depends on this; it is asserted once
    // explicitly so the reason is recorded where it can be read.
    expect(await prisma.session.count()).toBe(0);

    const mine = await createItem("repo-a");
    const theirs = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-theirs",
      rootSessionId: "root-b",
      itemId: theirs,
      machine: "desktop",
    });

    expect((await occupancyFor("s-mine"))?.rootSessionId).toBe("root-b");
  });

  it("names the most recently active holder when several share the tree", async () => {
    // `ORDER BY lastActive DESC`. Naming the stalest crew would point the
    // caller at whoever is least likely to still be there.
    const mine = await createItem("repo-a");
    const stale = await createItem("repo-a");
    const recent = await createItem("repo-a");
    await claim({ sessionId: "s-mine", rootSessionId: "root-a", itemId: mine, machine: "desktop" });
    await claim({
      sessionId: "s-stale",
      rootSessionId: "root-stale",
      itemId: stale,
      machine: "desktop",
    });
    await claim({
      sessionId: "s-recent",
      rootSessionId: "root-recent",
      itemId: recent,
      machine: "desktop",
    });
    await prisma.assignment.updateMany({
      where: { sessionId: "s-stale" },
      data: { lastActive: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect((await occupancyFor("s-mine"))?.rootSessionId).toBe("root-recent");
  });
});
