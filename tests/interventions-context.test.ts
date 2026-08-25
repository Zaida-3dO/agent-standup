// Context assembly for the intervention registry — MILESTONES.md #128,
// `src/lib/interventions/context.ts`.
//
// Two things are worth pinning here, and they pull in opposite directions:
//
//   1. **The cost gate.** `hook_decision` is the highest-volume path in the
//      system and touched no table before this row. `needs` is what keeps
//      that true for the calls that make up nearly all traffic, and a
//      regression in it would be invisible in behaviour — every finding
//      would still be correct, and the system would simply cost three
//      queries per tool call forever. Nothing but a test notices that.
//   2. **Absent means unknown.** Every field the assembler cannot honestly
//      answer is left off rather than defaulted, because the predicates are
//      written to treat absence as "no finding". A `false` written where
//      the truth is unknown converts a cautious entry into a confidently
//      wrong one — and for the blocking entries that is the difference
//      between a guard and an obstacle.
import { describe, expect, it } from "vitest";
import type { TransactionHandle } from "@/lib/service/context";
import { assembleContext, needs } from "@/lib/interventions/context";

/** A handle that records what it was asked, and answers nothing. */
function countingHandle(rows: unknown[] = []): TransactionHandle & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      queries.push(query);
      return rows as T;
    },
    $executeRawUnsafe: async () => {
      throw new Error("context assembly must never write");
    },
  } as TransactionHandle & { queries: string[] };
}

describe("needs — what a call could possibly require", () => {
  it("needs nothing for the commands that make up nearly all traffic", () => {
    for (const command of [
      undefined,
      "",
      "   ",
      "ls -la",
      "npm test",
      "git status",
      "git add src/lib/thing.ts",
      // A broad kill needs no state either: I12 blocks on shape alone, by
      // an explicitly settled decision against an ownership check.
      "taskkill /F /IM node.exe",
    ]) {
      expect(needs(command), String(command)).toEqual({
        assignment: false,
        approval: false,
        occupancy: false,
        handsOn: false,
      });
    }
  });

  it("I13 costs one assignment lookup on a commit or a push, and nothing more", () => {
    // These two were once asserted alongside `ls -la` as needing nothing.
    // I13 moved them, and the move is deliberate rather than a regression:
    // a commit and a push are **punctuation, not traffic**. A builder runs
    // hundreds of reads between them, so they are not in the volume class
    // the free-set assertion above exists to protect — and the lookup they
    // trigger is the same single `Assignment` query a merge already makes,
    // not a new query shape.
    //
    // What must stay true is the bound: one assignment lookup and no more.
    // An artifact question here would be paying the merge gate's price on
    // every commit in the system.
    for (const command of ["git commit -m 'x'", "git push", "git push --force origin main"]) {
      expect(needs(command), String(command)).toEqual({
        assignment: true,
        approval: false,
        occupancy: false,
        handsOn: false,
      });
    }
  });

  it("declines the commit shapes that record nothing new", () => {
    // An amend rewrites a commit that already exists — if the work was
    // unminted the finding was already due at the original commit, and
    // repeating it at every amend is how a guard becomes noise. A dry run
    // writes nothing at all.
    for (const command of [
      "git commit --amend --no-edit",
      "git commit --dry-run",
      "git push --dry-run",
    ]) {
      expect(needs(command), String(command)).toEqual({
        assignment: false,
        approval: false,
        occupancy: false,
        handsOn: false,
      });
    }
  });

  it("needs the claim and the approval for a merge attempt", () => {
    expect(needs("git merge feature")).toEqual({
      assignment: true,
      approval: true,
      occupancy: false,
      handsOn: false,
    });
    expect(needs("gh pr merge 12")).toEqual({
      assignment: true,
      approval: true,
      occupancy: false,
      handsOn: false,
    });
  });

  it("needs only the claim for a broad git add", () => {
    // Whether the checkout is shared is a fact about the claim. No artifact
    // question is involved, and paying for one would be the cost this split
    // exists to avoid.
    expect(needs("git add -A")).toEqual({
      assignment: true,
      approval: false,
      occupancy: false,
      handsOn: false,
    });
  });
});

describe("assembleContext — what it queries", () => {
  it("runs no query at all for an ordinary call", async () => {
    const db = countingHandle();
    const context = await assembleContext({ db, sessionId: "s1", tool: "Bash", command: "ls -la" });

    expect(db.queries).toEqual([]);
    expect(context).toEqual({ sessionId: "s1", tool: "Bash", command: "ls -la" });
  });

  it("runs no query when there is no command at all", async () => {
    const db = countingHandle();
    await assembleContext({ db, sessionId: "s1", tool: "Read" });
    expect(db.queries).toEqual([]);
  });

  it("looks up the claim for a command that could be the subject of a finding", async () => {
    const db = countingHandle();
    await assembleContext({ db, sessionId: "s1", tool: "Bash", command: "git add -A" });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]).toContain(`FROM "Assignment"`);
  });

  it("stops after the claim lookup when the session holds no claim", async () => {
    // No live claim is a common, legitimate state — an unclaimed session
    // running commands — and there is nothing further to ask about.
    const db = countingHandle([]);
    const context = await assembleContext({
      db,
      sessionId: "s1",
      tool: "Bash",
      command: "git merge feature",
    });

    expect(db.queries).toHaveLength(1);
    expect(context.itemId).toBeUndefined();
    expect(context.hasApprovalAtTip).toBeUndefined();
  });
});

describe("assembleContext — absent means unknown", () => {
  /** A handle answering the claim lookup with one row, and nothing else. */
  function claimHandle(claim: Record<string, unknown>): TransactionHandle {
    return {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes(`FROM "Assignment"`)) return [claim] as T;
        return [] as T;
      },
      $executeRawUnsafe: async () => {
        throw new Error("no");
      },
    };
  }

  it("leaves isLinkedWorktree absent when the claim recorded no worktree", async () => {
    // `null` means the claim never recorded one, which is **unknown**, not
    // "the shared checkout". Reading it as `false` would block a broad
    // `git add` on a guess about a checkout nobody described.
    const context = await assembleContext({
      db: claimHandle({ itemId: "i1", worktree: null, state: "executing", defaultBranch: "main" }),
      sessionId: "s1",
      command: "git add -A",
    });

    expect(context.itemId).toBe("i1");
    expect(context.isLinkedWorktree).toBeUndefined();
  });

  it("reads an empty worktree as the shared checkout and a path as a linked one", async () => {
    const shared = await assembleContext({
      db: claimHandle({ itemId: "i1", worktree: "", state: "executing", defaultBranch: "main" }),
      sessionId: "s1",
      command: "git add -A",
    });
    expect(shared.isLinkedWorktree).toBe(false);

    const linked = await assembleContext({
      db: claimHandle({
        itemId: "i1",
        worktree: "/w/wt-1",
        state: "executing",
        defaultBranch: "m",
      }),
      sessionId: "s1",
      command: "git add -A",
    });
    expect(linked.isLinkedWorktree).toBe(true);
  });

  it("leaves hasApprovalAtTip absent when the item has no commit artifact", async () => {
    // There is no tip for an approval to be at, so the question has no true
    // answer. An item nobody has committed to is not an item somebody is
    // merging without review; it is one that has not got there yet.
    const context = await assembleContext({
      db: claimHandle({ itemId: "i1", worktree: null, state: "executing", defaultBranch: "main" }),
      sessionId: "s1",
      command: "git merge feature",
    });

    expect(context.hasApprovalAtTip).toBeUndefined();
  });

  it("leaves defaultBranch absent when the repository never recorded one", async () => {
    // `Repo.defaultBranch` is deliberately nullable: unknown is a distinct,
    // representable state from a guess.
    const context = await assembleContext({
      db: claimHandle({ itemId: "i1", worktree: null, state: "executing", defaultBranch: null }),
      sessionId: "s1",
      command: "git merge feature",
    });

    expect(context.defaultBranch).toBeUndefined();
  });
});

describe("occupancy — who else holds this checkout (I15)", () => {
  /** A handle answering each query in turn, so a two-query path is testable. */
  function sequencedHandle(responses: unknown[][]): TransactionHandle & { queries: string[] } {
    const queries: string[] = [];
    let call = 0;
    return {
      queries,
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        queries.push(query);
        const answer = responses[call] ?? [];
        call += 1;
        return answer as T;
      },
      $executeRawUnsafe: async () => {
        throw new Error("context assembly must never write");
      },
    } as TransactionHandle & { queries: string[] };
  }

  const claimRow = {
    itemId: "item-a",
    worktree: null,
    state: "executing",
    defaultBranch: "main",
    rootSessionId: "root-mine",
    repo: "web",
    machine: "desktop",
  };

  it("costs nothing on a read, which is the whole point of the gate", async () => {
    // The property this row was told to preserve, asserted for the tool
    // gate specifically. `Read` cannot interleave anything with another
    // crew's work, so paying a query to tell it a crew is present would
    // spend the highest-volume path's budget to reach a conclusion nothing
    // could act on.
    const db = countingHandle();
    await assembleContext({ db, sessionId: "s1", tool: "Read" });
    expect(db.queries).toEqual([]);
  });

  it("costs nothing on an ordinary Bash call", async () => {
    // `Bash` is write-shaped for the nudge module's question and is *not*
    // the gate here, because `Bash` is also every `ls` and every
    // `git status`. Gating on it would put a query on the most common call
    // in the system.
    const db = countingHandle();
    await assembleContext({ db, sessionId: "s1", tool: "Bash", command: "ls -la" });
    expect(db.queries).toEqual([]);
  });

  it("looks for another crew when a file is edited", async () => {
    const db = sequencedHandle([[claimRow], []]);
    await assembleContext({ db, sessionId: "s1", tool: "Edit" });
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]).toContain(`FROM "Assignment"`);
  });

  it("reports the holder, named well enough to go and ask", async () => {
    const db = sequencedHandle([
      [claimRow],
      [
        {
          rootSessionId: "root-theirs",
          itemId: "item-b",
          branch: "feat/x",
          lastActiveSecondsAgo: 12,
        },
      ],
    ]);
    const context = await assembleContext({ db, sessionId: "s1", tool: "Write" });
    expect(context.occupyingCrew).toEqual({
      rootSessionId: "root-theirs",
      itemId: "item-b",
      branch: "feat/x",
      lastActiveSecondsAgo: 12,
    });
  });

  it("leaves the field absent when nobody else holds it", async () => {
    const db = sequencedHandle([[claimRow], []]);
    const context = await assembleContext({ db, sessionId: "s1", tool: "Write" });
    expect(context.occupyingCrew).toBeUndefined();
  });

  it("excludes the caller's own crew by root session", async () => {
    // The distinction `registered_processes` established, and I15 is its
    // first consumer: a worker an orchestrator spawned shares the checkout
    // legitimately and must never block itself. Asserted on the query
    // rather than on a row, because the exclusion is what the SQL does.
    const db = sequencedHandle([[claimRow], []]);
    await assembleContext({ db, sessionId: "s1", tool: "Write" });
    expect(db.queries[1]).toContain(`a."rootSessionId" <> $3`);
  });

  it("keys on the machine and the repo, never on the worktree path", async () => {
    // `worktree` is unnormalised free text, so two spellings of one
    // directory do not compare equal and a predicate over it would pass
    // silently on exactly the collisions it exists to catch.
    const db = sequencedHandle([[claimRow], []]);
    await assembleContext({ db, sessionId: "s1", tool: "Write" });
    const occupancyQuery = db.queries[1] ?? "";
    // The machine is read off the assignment, which is the row that owns
    // it: `claim` stores it there and creates no session row, so resolving
    // it through a session answers null for an ordinary claim and disables
    // the entry silently. The semantics of this query are pinned by
    // execution in `interventions-occupancy-db.test.ts`; these assertions
    // only guard the shape.
    expect(occupancyQuery).toContain(`a."machine" = $1`);
    expect(occupancyQuery).toContain(`i."repo" = $2`);
    expect(occupancyQuery).not.toContain(`"worktree"`);
  });

  it("ignores a crew that is not running", async () => {
    // A stalled or dead claim is the liveness sweep's business. Blocking on
    // one would refuse work on the strength of a crew that has finished.
    const db = sequencedHandle([[claimRow], []]);
    await assembleContext({ db, sessionId: "s1", tool: "Write" });
    const occupancyQuery = db.queries[1] ?? "";
    expect(occupancyQuery).toContain(`a."liveness" = 'running'`);
    expect(occupancyQuery).toContain(`a."releasedAt" IS NULL`);
  });

  it("asks nothing when the repository is unknown", async () => {
    // Half the pair being absent makes it unanswerable, and a query that
    // dropped that half would compare every checkout on the machine against
    // this one. Only the repository can be absent — `Assignment.machine` is
    // NOT NULL and `claim` requires it — so this is the whole of the case.
    const db = sequencedHandle([[{ ...claimRow, repo: null }], []]);
    const context = await assembleContext({ db, sessionId: "s1", tool: "Write" });
    expect(db.queries).toHaveLength(1);
    expect(context.occupyingCrew).toBeUndefined();
  });
});
