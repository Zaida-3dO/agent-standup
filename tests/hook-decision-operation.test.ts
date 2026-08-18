// `hook_decision` service operation — MILESTONES.md #125.
//
// Runs through the real `ServiceRuntime` (input parsing, settings
// resolution, the transaction boundary) but against a modelled, in-memory
// transaction handle rather than Postgres — this operation reads no table
// (same posture as `service_info`), so a real database proves nothing extra
// here.
//
// **What is worth pinning, now that nothing blocks yet.** A suite over an
// operation that always answers `allow` is trivially green, so the
// assertions that actually carry weight are the ones about the *shape* of
// the contract rather than the verdict:
//
//   - **`canBlock` tracks the phase and only the phase.** This is the
//     server's half of "a post entry cannot block" — the hook enforces the
//     same rule independently, so the invariant survives either side being
//     wrong, but not both.
//   - **The input schema is strict and validates before the handler runs.**
//     The hook is the highest-volume caller in the system and the one most
//     likely to drift; a field it starts sending that this schema does not
//     know about must fail loudly rather than be dropped.
//   - **The database is never touched.** Asserted with a handle that throws,
//     so this cannot pass by accident.
import { describe, expect, it } from "vitest";
import { ServiceRuntime } from "@/lib/service/runtime";
import type { TransactionHandle } from "@/lib/service/context";
import { InvalidInputError } from "@/lib/service/errors";
import { defaultSnapshot } from "@/lib/settings";

/** A transaction handle that fails loudly if the operation ever queries it. */
function untouchableHandle(): TransactionHandle {
  return {
    $queryRawUnsafe: async () => {
      throw new Error("hook_decision must not touch the database");
    },
    $executeRawUnsafe: async () => {
      throw new Error("hook_decision must not touch the database");
    },
  };
}

function runtime(): ServiceRuntime {
  return new ServiceRuntime({
    transaction: (body) => body(untouchableHandle()),
    resolveSnapshot: async () => defaultSnapshot(),
  });
}

type Answer = {
  decision: string;
  reason: string | null;
  canBlock: boolean;
  findings: readonly { id: string; level: string; timing: string; messages: { plain: string } }[];
};

async function call(input: Record<string, unknown>): Promise<Answer> {
  return (await runtime().call("hook_decision", input)) as unknown as Answer;
}

/**
 * Calls the operation with a handle that answers **only** the intervention
 * settings read, and still throws on anything else.
 *
 * Deliberately not a permissive handle. The point of `untouchableHandle` is
 * that a query nobody intended fails loudly, and a stub that answered every
 * query would give that up for the cases below — which are precisely the
 * cases where "it reads its configuration" and "it reads item state" must
 * stay distinguishable.
 */
async function callWithSettings(
  input: Record<string, unknown>,
  rows: readonly { key: string; value: unknown }[],
): Promise<Answer> {
  const handle: TransactionHandle = {
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      if (query.includes(`FROM "settings"`)) return rows as T;
      throw new Error(`hook_decision must not touch the database: ${query}`);
    },
    $executeRawUnsafe: async () => {
      throw new Error("hook_decision must not write");
    },
  };
  const service = new ServiceRuntime({
    transaction: (body) => body(handle),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return (await service.call("hook_decision", input)) as unknown as Answer;
}

/**
 * A handle that answers the three queries context assembly makes, from a
 * described world rather than from Postgres.
 *
 * Modelled rather than mocked per-call: the operation composes its own
 * queries and reuses the merge gate's primitives, so a test that asserted
 * on exact SQL strings would break on any refactor while proving nothing
 * about behaviour. This answers by *shape* — which table is being read —
 * and lets the assertions be about what the session is told.
 */
function worldHandle(world: {
  claim?: { itemId: string; worktree: string | null; state: string; defaultBranch: string | null };
  /** The item's `commit` artifacts, newest last. Empty means nothing committed. */
  commits?: { commitSha: string }[];
  /** Approving `code_review` artifacts, by the commit they approve. */
  approvals?: { commitSha: string | null; round: number }[];
}): TransactionHandle {
  const commits = world.commits ?? [];
  const approvals = world.approvals ?? [];
  const tip = commits.at(-1)?.commitSha ?? null;

  const round = approvals.reduce((highest, approval) => Math.max(highest, approval.round), 1);

  return {
    $queryRawUnsafe: async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
      if (query.includes(`FROM "Assignment"`)) {
        return (world.claim === undefined ? [] : [world.claim]) as T;
      }
      if (query.includes(`"kind" = 'commit'`)) {
        return (
          tip === null ? [] : [{ id: "c1", kind: "commit", verdict: null, commitSha: tip }]
        ) as T;
      }
      if (query.includes(`MAX("reviewRound")`)) {
        return [{ reviewRound: round }] as T;
      }
      // The approving-artifacts query, which is round-scoped — `$3` is the
      // round the caller resolved above. Filtering here rather than
      // returning everything is what lets a test describe an approval at an
      // earlier round and have it correctly not count.
      const askedRound = values[2];
      return approvals
        .filter((approval) => approval.round === askedRound)
        .map((approval, index) => ({
          id: `a${index}`,
          verdict: "lgtm",
          reviewRound: approval.round,
          commitSha: approval.commitSha,
          followUpItemId: null,
          createdByType: "agent",
        })) as T;
    },
    $executeRawUnsafe: async () => {
      throw new Error("hook_decision must never write");
    },
  };
}

async function callAgainst(
  world: Parameters<typeof worldHandle>[0],
  input: Record<string, unknown>,
): Promise<Answer> {
  const service = new ServiceRuntime({
    transaction: (body) => body(worldHandle(world)),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return (await service.call("hook_decision", input)) as unknown as Answer;
}

describe("what the operation answers", () => {
  it("allows a pre-tool call no intervention objects to", async () => {
    // `git push --force` is deliberately the example: it is alarming, and
    // no entry in the catalogue is about it. The registry answers the
    // situations it was given, not everything that looks dangerous — a
    // guard that objected to this would be a pattern list again.
    const answer = await call({
      eventType: "PreToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "git push --force",
    });

    expect(answer.decision).toBe("allow");
    expect(answer.reason).toBeNull();
    expect(answer.findings).toEqual([]);
  });

  it("allows a post-tool call", async () => {
    const answer = await call({
      eventType: "PostToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "ls",
      toolResult: "a.ts b.ts",
    });

    expect(answer.decision).toBe("allow");
  });

  it("allows a Stop, which carries no tool or command at all", async () => {
    const answer = await call({ eventType: "Stop", sessionId: "s1" });
    expect(answer.decision).toBe("allow");
  });
});

describe("canBlock tracks the phase", () => {
  it("is true for PreToolUse", async () => {
    expect((await call({ eventType: "PreToolUse", sessionId: "s1" })).canBlock).toBe(true);
  });

  it("is false for PostToolUse", async () => {
    // The server's half of the invariant. A change that made this true
    // would let a future gating row emit a block on a call that already
    // ran — which only the hook's own `canBlock` would then catch.
    expect((await call({ eventType: "PostToolUse", sessionId: "s1" })).canBlock).toBe(false);
  });

  it("is false for Stop", async () => {
    expect((await call({ eventType: "Stop", sessionId: "s1" })).canBlock).toBe(false);
  });

  it("does not depend on the tool or the command", async () => {
    // The rule is about the phase and nothing else. A `pre` call with no
    // command is still a moment at which something could be refused.
    expect((await call({ eventType: "PreToolUse", sessionId: "s1" })).canBlock).toBe(true);
    expect(
      (await call({ eventType: "PostToolUse", sessionId: "s1", tool: "Bash", command: "rm -rf /" }))
        .canBlock,
    ).toBe(false);
  });
});

describe("input validation happens before the handler", () => {
  it("rejects an unrecognised event type", async () => {
    await expect(call({ eventType: "BeforeToolUse", sessionId: "s1" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("rejects a missing session id", async () => {
    await expect(call({ eventType: "PreToolUse" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects an empty session id", async () => {
    await expect(call({ eventType: "PreToolUse", sessionId: "" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("rejects an unknown field rather than dropping it", async () => {
    // `.strict()`. The hook is the caller most likely to drift, and a field
    // it starts sending that is silently discarded is a change nobody sees
    // until the behaviour it was meant to drive never arrives.
    await expect(
      call({ eventType: "PreToolUse", sessionId: "s1", matchedList: "ask" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects a tool result past the operation's own ceiling", async () => {
    // The hook truncates before sending. This bound exists because an
    // operation must not trust its caller to have applied a limit the
    // caller could change.
    await expect(
      call({
        eventType: "PostToolUse",
        sessionId: "s1",
        toolResult: "x".repeat(8001),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("accepts a tool result at the ceiling", async () => {
    const answer = await call({
      eventType: "PostToolUse",
      sessionId: "s1",
      toolResult: "x".repeat(8000),
    });
    expect(answer.decision).toBe("allow");
  });

  it("accepts an empty command, which is different from an absent one", async () => {
    const answer = await call({ eventType: "PreToolUse", sessionId: "s1", command: "" });
    expect(answer.decision).toBe("allow");
  });

  it("rejects an empty tool name", async () => {
    await expect(
      call({ eventType: "PreToolUse", sessionId: "s1", tool: "" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("the operation touches no table on the ordinary path", () => {
  // The claim is narrower than it was and worth stating precisely: the
  // operation now consults the intervention registry, and two of those
  // entries genuinely need item and artifact state. What is preserved is
  // that a call which *could not* be the subject of any finding still costs
  // no query at all — which is the property that keeps the highest-volume
  // path in the system affordable. The handle throws on both raw methods,
  // so every case below passing is the assertion.

  it("completes for an event carrying no command", async () => {
    for (const eventType of ["PreToolUse", "PostToolUse", "Stop"]) {
      await expect(call({ eventType, sessionId: "s1" })).resolves.toMatchObject({
        decision: "allow",
      });
    }
  });

  it("completes for the ordinary tool calls that make up nearly all traffic", async () => {
    // The point of the whole `needs`/`assembleContext` split. If a future
    // change made context assembly unconditional, every one of these would
    // fail — which is precisely the regression worth catching, because it
    // would be invisible in behaviour and only show up as load.
    //
    // **`Bash` is on this list on purpose, and it is the load-bearing
    // entry.** It is the tool almost every call arrives on, and it is
    // write-shaped by the nudge module's reckoning — so a checkout-occupancy
    // gate keyed on "write-shaped" rather than on the file-editing tools
    // would put a query behind every `ls`, every `npm test` and every
    // `git status` here. That is the regression this case exists to catch,
    // and it caught it.
    const ordinary = [
      { tool: "Read", command: undefined },
      { tool: "Bash", command: "ls -la" },
      { tool: "Bash", command: "npm test" },
      { tool: "Bash", command: "git status" },
      { tool: "Bash", command: "git commit -m 'x'" },
      { tool: "Bash", command: "git add src/lib/thing.ts" },
    ];

    for (const { tool, command } of ordinary) {
      await expect(
        call({
          eventType: "PreToolUse",
          sessionId: "s1",
          tool,
          ...(command === undefined ? {} : { command }),
        }),
      ).resolves.toMatchObject({ decision: "allow" });
    }
  });

  it("looks up the claim for a file edit, which I15 can be about", async () => {
    // `Edit` leaves the free class deliberately, and the reason is worth
    // stating rather than quietly editing the list above: the property is
    // "a call that *could not* be the subject of any finding costs no
    // query", and an edit into a checkout another crew holds is exactly
    // what I15 is about — so an edit can be the subject of one, and paying
    // a query to find out is the entry working rather than the gate
    // leaking.
    //
    // It is still one lookup rather than an unconditional assembly, and it
    // is bounded to the three tools whose whole purpose is to modify a file.
    // The handle throws on any query, so reaching it is the assertion.
    await expect(
      call({ eventType: "PreToolUse", sessionId: "s1", tool: "Edit" }),
    ).rejects.toThrow();
  });

  it("blocks a broad process kill, reading only the configuration", async () => {
    // I12 needs no *item* state by design — it was settled as a prompt to
    // think rather than an ownership check — so no claim, item or artifact
    // is looked up for it, and the handle above would throw if one were.
    //
    // It does read the installation's intervention configuration, and that
    // is the point rather than a leak: an entry nobody can switch off is
    // not configurable, and this is the entry most likely to need it — it
    // blocks on the shape of a command alone, so an installation that finds
    // it too eager has no other remedy. One indexed range scan on a call
    // already being refused is the cheapest place in the system to pay for
    // that, and this case is what pins the distinction between "reads no
    // state" and "reads no configuration".
    const answer = await callWithSettings(
      {
        eventType: "PreToolUse",
        sessionId: "s1",
        tool: "Bash",
        command: "taskkill /F /IM node.exe",
      },
      [],
    );

    expect(answer.decision).toBe("block");
  });

  it("lets an installation switch a shape-only entry off", async () => {
    // The other half, and the reason the query above is worth its cost: a
    // stored override has to actually reach `evaluate`, or the settings
    // surface is a display that changes nothing.
    const answer = await callWithSettings(
      {
        eventType: "PreToolUse",
        sessionId: "s1",
        tool: "Bash",
        command: "taskkill /F /IM node.exe",
      },
      [{ key: "interventions.broad-process-kill.enabled", value: false }],
    );

    expect(answer.decision).toBe("allow");
    expect(answer.findings).toEqual([]);
  });

  it("completes for a Stop, which is advisory and asks the registry nothing", async () => {
    const answer = await call({ eventType: "Stop", sessionId: "s1" });
    expect(answer.decision).toBe("allow");
    expect(answer.findings).toEqual([]);
  });
});

describe("the intervention registry is consulted, and can refuse a call", () => {
  // The half of #128 that had to land. Before it, this operation allowed
  // unconditionally and its own comment said the registry was meant to be
  // consulted here. Every assertion below fails if that wiring is removed.

  const CLAIM = {
    itemId: "item-1",
    worktree: null,
    state: "executing",
    defaultBranch: "main",
  };

  it("blocks a merge when no approval stands at the item's tip", async () => {
    const answer = await callAgainst(
      { claim: CLAIM, commits: [{ commitSha: "aaa" }], approvals: [] },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    expect(answer.decision).toBe("block");
    expect(answer.findings.map((finding) => finding.id)).toContain("merge-without-approval-at-tip");
    // The reason is the sentence the session reads. A block with a null
    // reason is a refusal with no stated cause, which is the thing the hook
    // was built to stop happening.
    expect(answer.reason).toBeTruthy();
  });

  it("allows the same merge once an approval names the tip commit", async () => {
    // The conditional half. Same command, same session, different state —
    // which is the entire thesis: a command matcher cannot tell these two
    // calls apart, and this must.
    const answer = await callAgainst(
      {
        claim: CLAIM,
        commits: [{ commitSha: "aaa" }],
        approvals: [{ commitSha: "aaa", round: 1 }],
      },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    expect(answer.decision).toBe("allow");
    expect(answer.findings).toEqual([]);
  });

  it("blocks when the approval names an earlier commit than the tip", async () => {
    // Reviewed, then changed. The approval exists and is real; it is just
    // not about the code being merged.
    const answer = await callAgainst(
      {
        claim: CLAIM,
        commits: [{ commitSha: "aaa" }, { commitSha: "bbb" }],
        approvals: [{ commitSha: "aaa", round: 1 }],
      },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    expect(answer.decision).toBe("block");
  });

  it("blocks a `gh pr merge`, which is how work actually lands", async () => {
    // A check that only read `git merge` would be watching the door nobody
    // uses in this repository.
    const answer = await callAgainst(
      { claim: CLAIM, commits: [{ commitSha: "aaa" }], approvals: [] },
      {
        eventType: "PreToolUse",
        sessionId: "s1",
        tool: "Bash",
        command: "gh pr merge 12 --squash",
      },
    );

    expect(answer.decision).toBe("block");
  });

  it("allows a merge by a session holding no claim at all", async () => {
    // Very often the operator, and there is no item here whose review could
    // be missing. Blocking would be refusing a call about which the server
    // knows nothing.
    const answer = await callAgainst(
      {},
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    expect(answer.decision).toBe("allow");
  });

  it("allows a merge on an item with no commit artifact at all", async () => {
    // No tip exists, so "is there an approval at tip" has no true answer.
    // `assembleContext` leaves the field absent and the predicate declines,
    // rather than reading absent as `false` and blocking on a guess.
    const answer = await callAgainst(
      { claim: CLAIM, commits: [], approvals: [] },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    expect(answer.decision).toBe("allow");
  });

  it("blocks a broad `git add` in a shared checkout but not in a worktree", async () => {
    const shared = await callAgainst(
      { claim: { ...CLAIM, worktree: "" } },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git add -A" },
    );
    expect(shared.decision).toBe("block");

    const worktree = await callAgainst(
      { claim: { ...CLAIM, worktree: "/w/as-wt-1" } },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git add -A" },
    );
    expect(worktree.decision).toBe("allow");
  });

  it("never blocks a post event, however strong the finding would be", async () => {
    // The server's half of the invariant, asserted through the whole
    // operation rather than through the registry alone: the same world that
    // produces a block on `pre` must produce an allow on `post`.
    const answer = await callAgainst(
      { claim: CLAIM, commits: [{ commitSha: "aaa" }], approvals: [] },
      {
        eventType: "PostToolUse",
        sessionId: "s1",
        tool: "Bash",
        command: "git merge feature",
        toolResult: "Merge made by the 'ort' strategy.",
      },
    );

    expect(answer.decision).toBe("allow");
    expect(answer.canBlock).toBe(false);
    expect(answer.findings.every((finding) => finding.level === "nudge")).toBe(true);
  });
});

describe("what rides back with the answer", () => {
  it("carries findings on an allow, so a nudge is not lost with the verdict", async () => {
    const answer = await callAgainst(
      {
        claim: { itemId: "item-1", worktree: null, state: "in_review", defaultBranch: "main" },
        commits: [{ commitSha: "aaa" }],
        approvals: [],
      },
      { eventType: "PostToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );

    // Allowed, and still carrying advice. "Nothing triggered" and
    // "something triggered and it was only advice" are different facts, and
    // a response that carried only the decision could not tell them apart.
    expect(answer.decision).toBe("allow");
    expect(answer.findings.length).toBeGreaterThan(0);
  });

  it("marks a nudge as riding the digest and a block as immediate", async () => {
    // The accumulation seam. Delivery is not built, but the timing that
    // decides what a delivery would batch travels on every finding, so a
    // digest consumer needs no new signal from this operation.
    const nudged = await callAgainst(
      {
        claim: { itemId: "item-1", worktree: null, state: "in_review", defaultBranch: "main" },
        commits: [{ commitSha: "aaa" }],
        approvals: [],
      },
      { eventType: "PostToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );
    expect(nudged.findings.every((finding) => finding.timing === "digest")).toBe(true);

    const blocked = await callAgainst(
      {
        claim: { itemId: "item-1", worktree: null, state: "executing", defaultBranch: "main" },
        commits: [{ commitSha: "aaa" }],
        approvals: [],
      },
      { eventType: "PreToolUse", sessionId: "s1", tool: "Bash", command: "git merge feature" },
    );
    expect(blocked.findings.some((finding) => finding.timing === "immediate")).toBe(true);
  });
});
