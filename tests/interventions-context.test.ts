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
      "git commit -m 'x'",
      "git add src/lib/thing.ts",
      "git push",
      // A broad kill needs no state either: I12 blocks on shape alone, by
      // an explicitly settled decision against an ownership check.
      "taskkill /F /IM node.exe",
    ]) {
      expect(needs(command), String(command)).toEqual({ assignment: false, approval: false });
    }
  });

  it("needs the claim and the approval for a merge attempt", () => {
    expect(needs("git merge feature")).toEqual({ assignment: true, approval: true });
    expect(needs("gh pr merge 12")).toEqual({ assignment: true, approval: true });
  });

  it("needs only the claim for a broad git add", () => {
    // Whether the checkout is shared is a fact about the claim. No artifact
    // question is involved, and paying for one would be the cost this split
    // exists to avoid.
    expect(needs("git add -A")).toEqual({ assignment: true, approval: false });
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
