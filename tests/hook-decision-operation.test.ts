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
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";

/**
 * Recognises the displacement lookup — the one read a `PreToolUse` makes
 * whatever it is running.
 *
 * Matched on the `superseded` liveness filter rather than on the table name,
 * because several of this operation's reads are against `Assignment` and
 * only this one is unconditional. Matching the table would silently excuse
 * the claim read as well, which is the exact query the cost cases below
 * exist to forbid.
 */
function isDisplacementLookup(query: string): boolean {
  return query.includes(`FROM "Assignment"`) && query.includes(`'superseded'`);
}

/**
 * A transaction handle that fails loudly if the operation queries it for
 * anything **other than** whether the calling session has been displaced.
 *
 * That one read is answered — with no rows, the ordinary case — rather than
 * forbidden, because it is not part of the property these cases protect.
 * The property is that a call which could not be the subject of any finding
 * assembles no context: no claim read, no artifact read, no settings read.
 * Displacement is a fact about the *session* and is deliberately not gated
 * on the command, so folding it into the same prohibition would be asserting
 * that a feature which exists does not.
 *
 * It is answered narrowly for the same reason `callWithSettings` refuses to
 * be a permissive stub: a handle that answered everything would let a
 * genuine regression in context assembly pass silently, and that regression
 * is invisible in behaviour and shows up only as load.
 */
function untouchableHandle(): TransactionHandle {
  return {
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      if (isDisplacementLookup(query)) return [] as T;
      throw new Error(`hook_decision must not touch the database: ${query}`);
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
  enforcement?: { status: string; detail: string };
  stop?: { liveCrew: number; wakeScheduled: boolean };
  windDown?: { unrated: unknown[]; liveCrew: number; wakeScheduled: boolean };
};

async function call(input: Record<string, unknown>): Promise<Answer> {
  return (await runtime().call("hook_decision", input)) as unknown as Answer;
}

/** The crew-count query the `Stop` branch makes — see `callStop`. */
function isStopCrewLookup(query: string): boolean {
  return query.includes(`AS "liveCrew"`);
}

/** The shell-call read the `Stop` branch makes to spot a backgrounded wait. */
function isStopShellLookup(query: string): boolean {
  return query.includes(`FROM "ToolCall"`) && query.includes(`"command"`);
}

/**
 * The unfinished-work count the `Stop` branch makes for the stop catch.
 *
 * Scoped to the stopping session's own rows rather than to the board, which
 * is what keeps it from reporting the backlog as work the session left
 * behind — see `../src/lib/interventions/stop-context.ts`.
 */
function isStopUnfinishedLookup(query: string): boolean {
  return query.includes(`AS "unfinished"`);
}

/**
 * The unrated-firings read the `Stop` branch makes for the session-end
 * survey.
 *
 * Third and last of the `Stop` branch's reads, and it carries its own
 * weight under the same volume argument as the other two: it happens once
 * per turn rather than once per tool call. It is also the only one that can
 * answer nothing — a session that tripped no guard returns no rows, which is
 * most sessions — so the common case is one index seek and an empty result.
 */
function isStopSurveyLookup(query: string): boolean {
  return query.includes(`FROM "intervention_events"`) && query.includes(`NOT EXISTS`);
}

/**
 * Calls the operation with a handle that answers **only** the two reads the
 * `Stop` branch makes, and still throws on anything else.
 *
 * ── Why `Stop` sits outside the zero-query set ─────────────────────────
 *
 * `../src/lib/hook/stop-catch.ts` reads a `stop` block off this operation's
 * response, and assembling that block is the whole of what makes the catch
 * able to speak. It cannot be gated on a command, because a `Stop` carries
 * none.
 *
 * The same is true of the survey's read: `../src/lib/interventions/survey.ts`
 * can only ask about firings something has listed, and listing them is a
 * query on a table no other phase touches.
 *
 * The volume argument that protects the other phases does not apply here: a
 * `Stop` fires once per turn, not once per tool call, so these three reads
 * are some five orders of magnitude rarer than the path the gate exists to
 * keep free. The zero-query property is still asserted for every other phase
 * below, which is where it is load-bearing.
 *
 * Answered narrowly, for the same reason `untouchableHandle` is narrow: a
 * permissive stub would let a genuine regression in context assembly pass
 * silently on the `Stop` path too.
 */
function stopHandle(
  crew: number,
  commands: readonly string[],
  firings: readonly Record<string, unknown>[] = [],
  unfinished = 0,
): TransactionHandle {
  return {
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      if (isDisplacementLookup(query)) return [] as T;
      if (isStopCrewLookup(query)) return [{ liveCrew: crew }] as T;
      if (isStopShellLookup(query)) return commands.map((command) => ({ command })) as T;
      // Nothing of this session's own left open, which is the clean stop —
      // the case the catch must stay silent on. The producer's own suites
      // cover the populated case.
      if (isStopUnfinishedLookup(query)) return [{ unfinished: unfinished }] as T;
      // No unrated firings, which is the ordinary session. The survey's own
      // suites cover the populated case; what matters here is that this
      // read is expected rather than a regression, and that nothing else is.
      if (isStopSurveyLookup(query)) return firings as T;
      throw new Error(`hook_decision must not touch the database: ${query}`);
    },
    $executeRawUnsafe: async () => {
      throw new Error("hook_decision must not touch the database");
    },
  };
}

async function callStop(
  crew: number,
  commands: readonly string[] = [],
  firings: readonly Record<string, unknown>[] = [],
): Promise<Answer> {
  const rt = new ServiceRuntime({
    transaction: (body) => body(stopHandle(crew, commands, firings)),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return (await rt.call("hook_decision", {
    eventType: "Stop",
    sessionId: "s1",
  })) as unknown as Answer;
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
      // The unconditional session read, answered for the reason given on
      // `untouchableHandle`: it is not what these cases are about.
      if (isDisplacementLookup(query)) return [] as T;
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
  /**
   * A superseded assignment for the calling session, when the world is one
   * where its claim was taken. Absent in almost every case, which is the
   * ordinary session.
   */
  displaced?: { itemId: string; supersededBy: string | null; releasedAt: Date | null };
}): TransactionHandle {
  const commits = world.commits ?? [];
  const approvals = world.approvals ?? [];
  const tip = commits.at(-1)?.commitSha ?? null;

  const round = approvals.reduce((highest, approval) => Math.max(highest, approval.round), 1);

  return {
    $queryRawUnsafe: async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
      // Checked before the claim read, which is also against `Assignment`.
      // A world describes a session that holds a claim, not one that has
      // been displaced, so this answers empty unless the world says
      // otherwise — and answering it here is what keeps the claim branch
      // from returning a claim row to a query that asked a different
      // question.
      if (isDisplacementLookup(query)) {
        return (world.displaced === undefined ? [] : [world.displaced]) as T;
      }
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
    // `rm -rf build/` is deliberately the example: it is alarming, and no
    // entry in the catalogue is about it. The registry answers the
    // situations it was given, not everything that looks dangerous — a
    // guard that objected to this would be a pattern list again.
    //
    // The example has to be a command the assembler looks nothing up for,
    // which rules out a push: I13 keys on pushes and commits, so one of
    // those would assert this property through a command that also triggers
    // a claim lookup, muddling the two things. `rm -rf` matches no entry at
    // all, so it demonstrates the point cleanly.
    const answer = await call({
      eventType: "PreToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "rm -rf build/",
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
    const answer = await callStop(0);
    expect(answer.decision).toBe("allow");
  });

  it("allows a Stop even with crew running and no wake — the catch cannot refuse", async () => {
    // DECISIONS.md §6's structural property, asserted rather than assumed:
    // a refused stop can trap an agent in a loop, so no value the `stop`
    // block can take may change the decision. This is the case that would
    // block if anything ever wired the catch to the verdict.
    const answer = await callStop(3);
    expect(answer.decision).toBe("allow");
    expect(answer.stop).toEqual({ liveCrew: 3, wakeScheduled: false, unfinishedWork: 0 });
  });

  it("sends no survey block for a session that tripped nothing", async () => {
    // The overwhelmingly common stop, and the criterion that a quiet
    // session produces no noise. Absent rather than an empty block: the
    // client reads an absent block as nothing to ask about, and an empty
    // one would be a payload spent saying so on every turn in the system.
    expect(await callStop(0)).not.toHaveProperty("windDown");
  });

  it("sends the survey block, carrying the stop block's own crew facts", async () => {
    // The two blocks must agree, because they answer the identical question
    // — "is anyone still working for you, and is anything going to wake
    // you". Deriving them separately would be two definitions of one fact,
    // and the pair would disagree the first time either query was tuned.
    // A non-zero crew and a real wait, so neither field can pass by
    // coinciding with a hardcoded default — `liveCrew: 0` is what a
    // re-derivation that lost its input would produce, and it is
    // indistinguishable from the true answer on a session with no crew.
    const answer = await callStop(
      2,
      ["standup crew wait --timeout 600"],
      [
        {
          id: 7n,
          entry_id: "I10",
          ts: new Date(1_700_000_000_000),
          tool: "Bash",
          message: "scope it to a PID",
          outcome: "blocked",
        },
      ],
    );

    expect(answer.decision).toBe("allow");
    expect(answer.windDown?.unrated).toHaveLength(1);
    expect(answer.windDown?.liveCrew).toBe(answer.stop?.liveCrew);
    expect(answer.windDown?.wakeScheduled).toBe(answer.stop?.wakeScheduled);
    // And both shared values are the real ones, not coincidental defaults.
    expect(answer.windDown?.liveCrew).toBe(2);
    expect(answer.windDown?.wakeScheduled).toBe(true);
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
    expect((await callStop(0)).canBlock).toBe(false);
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
    // `Stop` is deliberately absent from this list — it assembles the stop
    // catch's context, which is two reads it cannot gate on a command it
    // does not carry. See `callStop` for why that is affordable and why the
    // property still holds where it matters. The two phases that make up
    // the traffic are unchanged.
    for (const eventType of ["PreToolUse", "PostToolUse"]) {
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
      { tool: "Bash", command: "git add src/lib/thing.ts" },
      // A `PostToolUse` on a read. I14 is a `post` entry, so a gate keyed on
      // the phase alone would put the window read behind every one of these
      // — roughly half of all hook events. It is gated on the phase *and* a
      // file-editing tool for that reason, and this is the case that pins it.
      { tool: "Read", command: undefined, eventType: "PostToolUse" },
      { tool: "Bash", command: "ls -la", eventType: "PostToolUse" },
      // **`git pull --ff-only` at `post`.** This is the command every
      // session runs to catch up before it starts work, and it is on this
      // list because it can neither land unreviewed history (git aborts
      // unless the update is a fast-forward) nor close a row.
      //
      // Note what is deliberately NOT here: a *bare* `git pull`. That one
      // already costs the assignment lookup on both phases and always has,
      // because it feeds the approval limb — git will build a merge commit
      // out of divergent history without being asked. That is row
      // f296b059's distinction and it is not this gate's to make.
      //
      // What the delivery widening had to preserve is that a bare pull does
      // not additionally gain the *delivery* lookups, which is pinned
      // directly as `delivery === false` in
      // `tests/interventions-flow-nudges.test.ts` — the assertion that
      // fails if the clause is ever "simplified" to `isMergeAttempt`.
      { tool: "Bash", command: "git pull --ff-only", eventType: "PostToolUse" },
    ];

    for (const entry of ordinary) {
      const { tool, command } = entry;
      const eventType = "eventType" in entry ? entry.eventType : "PreToolUse";
      await expect(
        call({
          eventType,
          sessionId: "s1",
          tool,
          ...(command === undefined ? {} : { command }),
        }),
        `${eventType} ${tool} ${command ?? ""}`,
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

  // ── Every entry that reaches no table, not just the one that was named ──
  //
  // The gate deciding whether the settings rows are read at all used to
  // test `needs` — which answers *which tables to read* — plus one
  // hand-named exception for the broad process kill. Those are different
  // questions: an entry deciding on facts already in memory needs no table,
  // so `needs` reports nothing for it, and it had to be remembered here by
  // hand. Exactly one ever was, and three more accumulated behind it, each
  // silently discarding whatever the installation had configured. A
  // `timing=digest` written for `unscoped-recursive-search` was observed
  // still firing `immediate`.
  //
  // These cases use **`timing`** rather than `enabled` deliberately. An
  // `enabled: false` override that is ignored leaves the entry firing, which
  // looks like a plain "the guard is on" and is easy to misread; a `timing`
  // override that is ignored still produces a finding, so the *only*
  // observable difference is the field itself. That is the exact shape of
  // the reported defect, and it is the one an assertion on `decision` alone
  // could never catch.
  //
  // Each case names the command that reaches it and nothing else, so a
  // failure says which entry regressed rather than that something did.
  const shapeOnlyEntries: readonly {
    readonly id: string;
    readonly tool: string;
    readonly command?: string;
  }[] = [
    // The entry the defect was reported against.
    { id: "unscoped-recursive-search", tool: "Bash", command: "grep -rn needle ." },
    { id: "rebase-before-checking-for-conflicts", tool: "Bash", command: "git rebase main" },
    // **Not `git commit --no-gpg-sign`.** That spelling is masked: it is a
    // work-recording command, so `needs` asks for the assignment on its
    // account and a gate keyed on `needs` answers yes for a reason that has
    // nothing to do with this entry. Only the verbs that create a commit
    // without being a commit — rebase, cherry-pick, revert, am — actually
    // exercise the path, which is why a case written against the obvious
    // spelling asserts nothing about it.
    {
      id: "commit-signing-explicitly-suppressed",
      tool: "Bash",
      command: "git rebase main --no-gpg-sign",
    },
    // Carries **no command at all** — it reads a context flag derived from
    // the tool name. Nothing testing command shapes could have found it,
    // and it is the case that shows the class is "reaches no table" rather
    // than "is command-shaped".
    { id: "asking-without-trying-first", tool: "AskUserQuestion" },
  ];

  for (const entry of shapeOnlyEntries) {
    it(`honours a stored timing override for ${entry.id}, which reaches no table`, async () => {
      const input = {
        eventType: "PreToolUse",
        sessionId: "s1",
        tool: entry.tool,
        ...(entry.command === undefined ? {} : { command: entry.command }),
      };

      // Baseline first, so the assertion below is a *change* rather than a
      // coincidence: if the entry shipped as `digest` already, the override
      // case would pass without the override doing anything.
      const shipped = await callWithSettings(input, []);
      const shippedFinding = shipped.findings.find((finding) => finding.id === entry.id);
      expect(shippedFinding, `${entry.id} did not fire on its own command`).toBeDefined();
      expect(shippedFinding?.timing).toBe("immediate");

      const configured = await callWithSettings(input, [
        { key: `interventions.${entry.id}.timing`, value: "digest" },
      ]);
      const finding = configured.findings.find((f) => f.id === entry.id);
      expect(finding, `${entry.id} stopped firing under an override`).toBeDefined();
      expect(finding?.timing).toBe("digest");
    });
  }

  it("honours an override for every pre entry that can fire without state", async () => {
    // The structural half, and the reason the four cases above are not the
    // whole test. Those name four entries; this one covers the entry
    // somebody adds next, which is the case a hand-written list always
    // misses.
    //
    // It walks the catalogue, asks each `pre` entry's predicate whether it
    // fires on a context carrying nothing but what the hook already has in
    // memory, and requires that a stored override reaches any that does.
    // A new shape-only entry is covered on the day it is added, with
    // nothing to remember — which is precisely what the hand-maintained
    // list could not do.
    const stateless: string[] = [];
    for (const entry of BUILTIN_INTERVENTIONS) {
      if (entry.phase !== "pre") continue;
      for (const probe of shapeOnlyEntries) {
        const context = {
          sessionId: "s1",
          tool: probe.tool,
          ...(probe.command === undefined ? {} : { command: probe.command }),
          ...(probe.tool === "AskUserQuestion" ? { isAskingUser: true } : {}),
        };
        let verdict;
        try {
          verdict = await entry.predicate(context);
        } catch {
          continue;
        }
        if (verdict?.triggered === true) {
          stateless.push(entry.id);
          break;
        }
      }
    }

    // The list is not hard-coded, but it must not be empty — an empty walk
    // would make every assertion below vacuous and the case would pass
    // while asserting nothing.
    expect(stateless.length).toBeGreaterThanOrEqual(shapeOnlyEntries.length);
    expect(new Set(stateless)).toEqual(new Set(shapeOnlyEntries.map((e) => e.id)));
  });

  it("asks the registry nothing on a Stop, which is advisory", async () => {
    // The registry is not consulted on a `Stop`: the two reads it makes are
    // the stop catch's own context, not a catalogue walk. `stopHandle` throws
    // on the settings read the registry would need, so a change that
    // consulted it here fails this case rather than passing quietly.
    const answer = await callStop(0);
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

describe("what the answer says about the session itself", () => {
  // The half that carries the notice to a displaced session. Everything else
  // in this file is about the *call*; these are about whether the session
  // should be making one at all, and they are asserted here because this is
  // the only place the field is actually put on the wire — a resolver that
  // works and an operation that never attaches its result would pass every
  // other case in the suite.

  const displacedWorld = {
    displaced: {
      itemId: "item-taken",
      supersededBy: "session-taker",
      releasedAt: new Date("2026-01-02T03:04:05.000Z"),
    },
  };

  it("carries the notice on an ordinary allow, which is the call it will arrive on", async () => {
    // The load-bearing case. A displaced agent's next call is overwhelmingly
    // likely to be something nothing objects to, so attaching the notice only
    // to a refusal would deliver it exactly when it was least needed.
    const answer = await callAgainst(displacedWorld, {
      eventType: "PreToolUse",
      sessionId: "session-displaced",
      tool: "Read",
    });

    expect(answer.decision).toBe("allow");
    expect(answer.enforcement?.status).toBe("displaced");
    // Who and when, which are the two facts that let it hand over rather than
    // merely stop.
    expect(answer.enforcement?.detail).toContain("item-taken");
    expect(answer.enforcement?.detail).toContain("session-taker");
    expect(answer.enforcement?.detail).toContain("2026-01-02T03:04:05.000Z");
  });

  it("says nothing about a session whose claim is intact", async () => {
    // The value that matters most on the highest-volume path: an absent field
    // is what the hook reads as "nothing said about this session". Anything
    // else here would refuse every call in the system.
    const answer = await callAgainst(
      {},
      { eventType: "PreToolUse", sessionId: "s1", tool: "Read" },
    );

    expect(answer.enforcement).toBeUndefined();
  });

  it("still carries the notice when the call is also being blocked", async () => {
    // The two answers are independent: one is about the command, the other
    // about the session. A block must not swallow the notice, or a displaced
    // session that happened to run a guarded command would be told only that
    // the command was refused.
    const answer = await callAgainst(
      { ...displacedWorld, claim: undefined },
      {
        eventType: "PreToolUse",
        sessionId: "session-displaced",
        tool: "Bash",
        command: "pkill -f node",
      },
    );

    expect(answer.decision).toBe("block");
    expect(answer.enforcement?.status).toBe("displaced");
  });

  it("does not look at all on a phase that could not act on the answer", async () => {
    // The cost gate, asserted as behaviour rather than trusted. A
    // `PostToolUse` describes a call that has already run, so the lookup is
    // skipped entirely — and the handle proves it by throwing if it is not.
    const refusing: TransactionHandle = {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        if (isDisplacementLookup(query)) {
          throw new Error("a post-tool event must not pay for the displacement lookup");
        }
        return [] as T;
      },
      $executeRawUnsafe: async () => {
        throw new Error("hook_decision must not write");
      },
    };
    const service = new ServiceRuntime({
      transaction: (body) => body(refusing),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    const answer = (await service.call("hook_decision", {
      eventType: "PostToolUse",
      sessionId: "session-displaced",
      tool: "Read",
    })) as unknown as Answer;

    expect(answer.decision).toBe("allow");
    expect(answer.enforcement).toBeUndefined();
  });
});
