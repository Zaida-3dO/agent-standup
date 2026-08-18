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
//   - **A different crew on the same `(machine, repo)` must be found.** This
//     is the entry's whole purpose, and the binding order is what decides
//     whether the pair is even compared correctly.
//   - **A released or non-running holder must not count.** A finished crew's
//     claim would otherwise refuse work indefinitely.
//   - **A different machine, or a different repository, is a different
//     checkout.** Dropping either half of the pair matches everything.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/interventions/context";
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
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  /** A live claim. Every field the predicate keys on is explicit here. */
  async function claim(options: {
    sessionId: string;
    rootSessionId: string;
    itemId: string;
    machine: string;
    worktree?: string | null;
    branch?: string;
    liveness?: "running" | "stalled" | "dead";
    released?: boolean;
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
        worktree: options.worktree ?? null,
        branch: options.branch ?? null,
        liveness: (options.liveness ?? "running") as never,
        releasedAt: options.released === true ? new Date() : null,
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

  it("finds another crew on the same machine and repository", async () => {
    // The entry's whole purpose. Two distinct roots, one machine, one repo.
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

  it("names the most recently active holder when several are present", async () => {
    // `ORDER BY lastActive DESC LIMIT 1`. Naming the stalest crew would
    // point the caller at whoever is least likely to still be there.
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
