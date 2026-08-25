// MILESTONES.md #128 — the intervention registry's shape
// (`src/lib/interventions/`).
//
// Most of what is worth testing here is the *contract* the catalogue and
// the eventual custom entries are held to, rather than any one entry's
// detection — the entries' own detections are proved against the assembled
// context in `hook-decision-operation.test.ts`, which is where they meet
// real state. Four properties, each with the change that breaks it:
//
//   1. **A `post` entry cannot block.** Enforced at three separate points
//      — registration, override, and the predicate's own returned level —
//      and each is asserted individually, because deleting any one of them
//      leaves the other two passing while opening a real hole.
//   2. **A predicate returns a value and emits nothing.** Asserted by the
//      only means available: the registry, not the predicate, is what turns
//      a verdict into a finding, so a predicate's `level` is *resolved*
//      rather than obeyed.
//   3. **Blocking is always immediate.** Deleting the clamp in
//      `resolveTiming` lets a block ride a five-minute digest, arriving
//      long after the call it was meant to stop.
//   4. **A throwing predicate costs its own finding and nothing else.**
//      Removing the `try` fails the tool call that happened to run it.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  InterventionRegistryError,
  assertRegistryValid,
  evaluate,
  resolveLevel,
  resolveTiming,
  strongestLevel,
} from "@/lib/interventions/registry";
import {
  BUILTIN_INTERVENTIONS,
  UNIMPLEMENTED_CATALOGUE_ENTRIES,
  isBroadGitAdd,
} from "@/lib/interventions/builtins";
import {
  isBlockingLevel,
  type Intervention,
  type InterventionLevel,
  type InterventionPhase,
  type InterventionVerdict,
} from "@/lib/interventions/types";

function entry(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: "example",
    source: "builtin",
    summary: "An example situation.",
    phase: "pre",
    audience: "agent",
    defaultLevel: "nudge",
    defaultTiming: "digest",
    messages: { plain: "plain text", prominent: "PROMINENT TEXT" },
    predicate: () => ({ triggered: true }),
    ...overrides,
  };
}

describe("a post entry cannot block", () => {
  it("refuses to register a post entry whose default level blocks", () => {
    expect(() =>
      assertRegistryValid([entry({ phase: "post", defaultLevel: "block-overridable" })]),
    ).toThrow(InterventionRegistryError);

    expect(() =>
      assertRegistryValid([entry({ phase: "post", defaultLevel: "hard-block" })]),
    ).toThrow(/cannot refuse it/);
  });

  it("registers a pre entry with the same blocking level without complaint", () => {
    // The mirror of the case above. Without it, a bug that rejected *every*
    // blocking entry would pass the test above and break the feature.
    expect(() =>
      assertRegistryValid([entry({ phase: "pre", defaultLevel: "hard-block" })]),
    ).not.toThrow();
  });

  it("clamps an override that sets a post entry to a blocking level", async () => {
    const findings = await evaluate({
      entries: [entry({ id: "p", phase: "post", defaultLevel: "nudge" })],
      phase: "post",
      context: {},
      overrides: { p: { level: "hard-block" } },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("nudge");
  });

  it("clamps a blocking level returned by the predicate itself on a post entry", async () => {
    // This is the path an external script would eventually come in on, and
    // the one input the registry must not trust to respect the rule.
    const findings = await evaluate({
      entries: [
        entry({
          id: "p",
          phase: "post",
          predicate: (): InterventionVerdict => ({ triggered: true, level: "block-overridable" }),
        }),
      ],
      phase: "post",
      context: {},
    });

    expect(findings[0]?.level).toBe("nudge");
  });

  it("leaves a blocking level alone on a pre entry", async () => {
    const findings = await evaluate({
      entries: [
        entry({
          id: "p",
          phase: "pre",
          predicate: (): InterventionVerdict => ({ triggered: true, level: "hard-block" }),
        }),
      ],
      phase: "pre",
      context: {},
    });

    expect(findings[0]?.level).toBe("hard-block");
  });

  it("resolveLevel clamps only the post/blocking combination", () => {
    const cases: ReadonlyArray<[InterventionPhase, InterventionLevel, InterventionLevel]> = [
      ["post", "hard-block", "nudge"],
      ["post", "block-overridable", "nudge"],
      ["post", "nudge", "nudge"],
      ["post", "nothing", "nothing"],
      ["pre", "hard-block", "hard-block"],
      ["pre", "block-overridable", "block-overridable"],
      ["pre", "nudge", "nudge"],
    ];

    for (const [phase, requested, expected] of cases) {
      expect(resolveLevel(phase, requested), `${phase}/${requested}`).toBe(expected);
    }
  });

  it("every shipped built-in obeys the invariant", () => {
    expect(() => assertRegistryValid(BUILTIN_INTERVENTIONS)).not.toThrow();
    for (const built of BUILTIN_INTERVENTIONS) {
      if (built.phase === "post") expect(isBlockingLevel(built.defaultLevel)).toBe(false);
    }
  });
});

describe("registration invariants", () => {
  it("refuses two entries sharing an id", () => {
    expect(() => assertRegistryValid([entry({ id: "same" }), entry({ id: "same" })])).toThrow(
      /must be unique/,
    );
  });

  it("refuses an empty id", () => {
    expect(() => assertRegistryValid([entry({ id: "  " })])).toThrow(/non-empty id/);
  });

  it("accepts distinct ids", () => {
    expect(() => assertRegistryValid([entry({ id: "a" }), entry({ id: "b" })])).not.toThrow();
  });
});

describe("timing", () => {
  it("forces a blocking finding to fire immediately whatever was configured", async () => {
    const findings = await evaluate({
      entries: [
        entry({ id: "b", phase: "pre", defaultLevel: "hard-block", defaultTiming: "digest" }),
      ],
      phase: "pre",
      context: {},
    });

    // A block that rode a digest would arrive five minutes after the call
    // it was meant to stop.
    expect(findings[0]?.timing).toBe("immediate");
  });

  it("leaves a nudge's configured timing alone", async () => {
    const findings = await evaluate({
      entries: [entry({ id: "n", defaultLevel: "nudge", defaultTiming: "digest" })],
      phase: "pre",
      context: {},
    });

    expect(findings[0]?.timing).toBe("digest");
  });

  it("lets an override move a nudge to immediate", async () => {
    const findings = await evaluate({
      entries: [entry({ id: "n", defaultLevel: "nudge", defaultTiming: "digest" })],
      phase: "pre",
      context: {},
      overrides: { n: { timing: "immediate" } },
    });

    expect(findings[0]?.timing).toBe("immediate");
  });

  it("resolveTiming forces immediate for both blocking levels only", () => {
    expect(resolveTiming("hard-block", "digest")).toBe("immediate");
    expect(resolveTiming("block-overridable", "digest")).toBe("immediate");
    expect(resolveTiming("nudge", "digest")).toBe("digest");
    expect(resolveTiming("nothing", "digest")).toBe("digest");
  });
});

describe("the predicate returns a value and the registry decides", () => {
  it("is handed only the context, and never anything it could fetch through", async () => {
    const predicate = vi.fn((): InterventionVerdict => ({ triggered: false }));
    const context = { sessionId: "s-1", tool: "Bash", command: "git status" };

    await evaluate({ entries: [entry({ predicate })], phase: "pre", context });

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith(context);
    // One argument, not two: an entry cannot be handed a client alongside
    // its context without this failing.
    expect(predicate.mock.calls[0]).toHaveLength(1);
  });

  it("produces nothing for a predicate that did not trigger", async () => {
    const findings = await evaluate({
      entries: [entry({ predicate: () => ({ triggered: false }) })],
      phase: "pre",
      context: {},
    });

    expect(findings).toEqual([]);
  });

  it("treats a missing `triggered` as not triggered", async () => {
    const findings = await evaluate({
      entries: [entry({ predicate: () => ({}) as InterventionVerdict })],
      phase: "pre",
      context: {},
    });

    expect(findings).toEqual([]);
  });

  it("carries the predicate's data onto the finding", async () => {
    const findings = await evaluate({
      entries: [entry({ predicate: () => ({ triggered: true, data: { itemId: 7 } }) })],
      phase: "pre",
      context: {},
    });

    expect(findings[0]?.data).toEqual({ itemId: 7 });
  });

  it("omits `data` entirely when the predicate supplied none", async () => {
    const findings = await evaluate({ entries: [entry()], phase: "pre", context: {} });

    expect(findings[0]).not.toHaveProperty("data");
  });

  it("awaits an async predicate", async () => {
    const findings = await evaluate({
      entries: [entry({ predicate: async () => ({ triggered: true }) })],
      phase: "pre",
      context: {},
    });

    expect(findings).toHaveLength(1);
  });

  it("drops a throwing predicate's finding and keeps every other entry", async () => {
    const findings = await evaluate({
      entries: [
        entry({
          id: "boom",
          predicate: () => {
            throw new Error("a custom script with a typo");
          },
        }),
        entry({ id: "fine" }),
      ],
      phase: "pre",
      context: {},
    });

    expect(findings.map((f) => f.id)).toEqual(["fine"]);
  });

  it("drops a rejecting async predicate the same way", async () => {
    const findings = await evaluate({
      entries: [
        entry({ id: "boom", predicate: async () => Promise.reject(new Error("timed out")) }),
        entry({ id: "fine" }),
      ],
      phase: "pre",
      context: {},
    });

    expect(findings.map((f) => f.id)).toEqual(["fine"]);
  });
});

describe("phase selection and overrides", () => {
  it("runs only the entries for the phase asked for", async () => {
    const pre = vi.fn((): InterventionVerdict => ({ triggered: true }));
    const post = vi.fn((): InterventionVerdict => ({ triggered: true }));

    const findings = await evaluate({
      entries: [
        entry({ id: "a", phase: "pre", predicate: pre }),
        entry({ id: "b", phase: "post", predicate: post }),
      ],
      phase: "pre",
      context: {},
    });

    expect(findings.map((f) => f.id)).toEqual(["a"]);
    // Not merely absent from the output — never run at all, because a
    // predicate for the wrong phase is being asked a question about a moment
    // that has not arrived.
    expect(post).not.toHaveBeenCalled();
  });

  it("skips an entry the installation disabled, without running its predicate", async () => {
    const predicate = vi.fn((): InterventionVerdict => ({ triggered: true }));

    const findings = await evaluate({
      entries: [entry({ id: "off", predicate })],
      phase: "pre",
      context: {},
      overrides: { off: { enabled: false } },
    });

    expect(findings).toEqual([]);
    expect(predicate).not.toHaveBeenCalled();
  });

  it("runs an entry whose override says nothing about `enabled`", async () => {
    // An override that only rewrites a message must not read as switched off.
    const findings = await evaluate({
      entries: [entry({ id: "on" })],
      phase: "pre",
      context: {},
      overrides: { on: { messages: { plain: "rewritten" } } },
    });

    expect(findings).toHaveLength(1);
  });

  it("applies an override's messages field by field over the defaults", async () => {
    const findings = await evaluate({
      entries: [entry({ id: "m" })],
      phase: "pre",
      context: {},
      overrides: { m: { messages: { plain: "rewritten plain" } } },
    });

    expect(findings[0]?.messages).toEqual({
      plain: "rewritten plain",
      // Untouched: an installation that expressed an opinion about one form
      // has not thereby expressed one about the other.
      prominent: "PROMINENT TEXT",
    });
  });

  it("tracks the shipped defaults for an entry with no override at all", async () => {
    const findings = await evaluate({ entries: [entry({ id: "d" })], phase: "pre", context: {} });

    expect(findings[0]?.messages).toEqual({ plain: "plain text", prominent: "PROMINENT TEXT" });
    expect(findings[0]?.level).toBe("nudge");
    expect(findings[0]?.timing).toBe("digest");
  });

  it("prefers the predicate's level over the installation's override", async () => {
    const findings = await evaluate({
      entries: [
        entry({
          id: "p",
          predicate: () => ({ triggered: true, level: "hard-block" }),
        }),
      ],
      phase: "pre",
      context: {},
      overrides: { p: { level: "nothing" } },
    });

    // A predicate naming a level is describing *this* firing; an override
    // describes every firing, so the narrower one wins.
    expect(findings[0]?.level).toBe("hard-block");
  });

  it("uses a predicate's message for both forms when it supplies one", async () => {
    const findings = await evaluate({
      entries: [entry({ predicate: () => ({ triggered: true, message: "specific sentence" }) })],
      phase: "pre",
      context: {},
    });

    expect(findings[0]?.messages).toEqual({
      plain: "specific sentence",
      prominent: "specific sentence",
    });
  });

  it("still produces a finding at level `nothing`", async () => {
    // `nothing` is "detected and recorded, says nothing" — a finding that
    // was filtered out here could not be observed before switching it on,
    // which is the level's whole purpose.
    const findings = await evaluate({
      entries: [entry({ id: "quiet", defaultLevel: "nothing" })],
      phase: "pre",
      context: {},
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("nothing");
  });
});

describe("strongestLevel", () => {
  it("is `nothing` for no findings", () => {
    expect(strongestLevel([])).toBe("nothing");
  });

  it("picks the strongest, not the first or the last", async () => {
    const findings = await evaluate({
      entries: [
        entry({ id: "a", defaultLevel: "nudge" }),
        entry({ id: "b", defaultLevel: "hard-block" }),
        entry({ id: "c", defaultLevel: "nothing" }),
      ],
      phase: "pre",
      context: {},
    });

    expect(strongestLevel(findings)).toBe("hard-block");
  });

  it("orders block-overridable below hard-block", async () => {
    const findings = await evaluate({
      entries: [
        entry({ id: "a", defaultLevel: "block-overridable" }),
        entry({ id: "b", defaultLevel: "nudge" }),
      ],
      phase: "pre",
      context: {},
    });

    expect(strongestLevel(findings)).toBe("block-overridable");
  });
});

describe("the example built-ins", () => {
  it("recognises the documented broad git add forms", () => {
    for (const command of [
      "git add -A",
      "git add --all",
      "git add -u",
      "git add .",
      "git add :/",
      "cd repo && git add -A",
    ]) {
      expect(isBroadGitAdd(command), command).toBe(true);
    }
  });

  it("does not recognise a staged-by-path add", () => {
    // The false positive that would matter: a correct command blocked.
    for (const command of [
      "git add src/index.ts",
      "git add ./src",
      "git add -- src/a.ts src/b.ts",
      "git status",
      "git commit -m 'add -A to the docs'",
    ]) {
      expect(isBroadGitAdd(command), command).toBe(false);
    }
  });

  it("blocks a broad add in a shared checkout", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git add -A", isLinkedWorktree: false },
    });

    expect(findings.map((f) => f.id)).toEqual(["broad-git-add-on-shared-checkout"]);
    expect(findings[0]?.level).toBe("block-overridable");
  });

  it("says nothing about the same command in a linked worktree", async () => {
    // The condition a command matcher structurally could not express: the
    // command text is identical and the answer is opposite.
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git add -A", isLinkedWorktree: true },
    });

    expect(findings).toEqual([]);
  });

  it("says nothing when it cannot tell whether the checkout is shared", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git add -A" },
    });

    expect(findings).toEqual([]);
  });

  it("nudges about an unapproved item in review, and never blocks it", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "post",
      context: { itemState: "in_review", hasApprovalAtTip: false, itemId: "item-42" },
      // Configured as strongly as the settings page allows. It is still a nudge.
      overrides: { "review-without-approval-at-tip": { level: "hard-block" } },
    });

    // Two `post` entries answer this context — I1 ("nothing is reviewing
    // this") and I7 ("nothing has approved it at tip"). They are genuinely
    // different findings addressed to the same reader, and the assertion
    // that matters is the invariant: neither blocks, however configured.
    const clamped = findings.find((finding) => finding.id === "review-without-approval-at-tip");
    expect(clamped?.level).toBe("nudge");
    expect(clamped?.data).toEqual({ itemId: "item-42" });
    expect(findings.every((finding) => finding.level === "nudge")).toBe(true);
  });

  it("says nothing about an item that has an approval at tip", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "post",
      context: { itemState: "in_review", hasApprovalAtTip: true },
    });

    expect(findings).toEqual([]);
  });
});

describe("the correctness entries that block", () => {
  // I10 and I12 — the two the catalogue files under "the ones that should
  // block", and the reason this mechanism exists rather than a pattern
  // list. Each is asserted both ways round: it fires on the situation, and
  // it declines on the near-miss a command matcher could not tell apart.

  it("I10 blocks a merge only when an approval is known to be absent", async () => {
    const merging = { command: "git merge feature", itemId: "i1" };

    const unapproved = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { ...merging, hasApprovalAtTip: false },
    });
    expect(unapproved.map((finding) => finding.id)).toContain("merge-without-approval-at-tip");
    expect(strongestLevel(unapproved)).toBe("block-overridable");

    // Approved at tip — the same command, refused or allowed on state
    // alone, which is the whole thesis.
    const approved = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { ...merging, hasApprovalAtTip: true },
    });
    expect(approved).toEqual([]);

    // Unknown. Absent is not `false`: blocking a merge on a question the
    // server could not answer is how a guard becomes an obstacle.
    const unknown = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: merging,
    });
    expect(unknown).toEqual([]);
  });

  it("I12 blocks a broad kill and allows a scoped one, needing no state", async () => {
    // Note the contexts carry nothing but a command. I12 was settled as a
    // prompt to think rather than an ownership check, so it must reach a
    // verdict with no item, no claim and no registry.
    const broad = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "taskkill /F /IM node.exe" },
    });
    expect(broad.map((finding) => finding.id)).toContain("broad-process-kill");
    expect(strongestLevel(broad)).toBe("block-overridable");

    const scoped = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "kill -9 1234" },
    });
    expect(scoped).toEqual([]);
  });

  it("every blocking builtin is overridable rather than a hard block", async () => {
    // The catalogue's own rule: the value is the recorded reason, not the
    // friction. A `hard-block` here would be a decision to refuse work with
    // no route through it, which nothing on this list has earned.
    for (const entry of BUILTIN_INTERVENTIONS) {
      if (entry.defaultLevel === "hard-block") {
        throw new Error(`${entry.id} defaults to hard-block; the catalogue calls for overridable`);
      }
    }
  });
});

describe("I15 — a checkout another crew already holds", () => {
  const entry = BUILTIN_INTERVENTIONS.find((one) => one.id === "checkout-held-by-another-crew");

  it("is registered as a blocking pre entry", () => {
    expect(entry).toBeDefined();
    expect(entry?.phase).toBe("pre");
    expect(entry?.defaultLevel).toBe("block-overridable");
    // Blocks are always immediate — a block that rode a digest would arrive
    // five minutes after the call it was meant to stop.
    expect(entry?.defaultTiming).toBe("immediate");
  });

  it("does not fire when nobody else holds the checkout", async () => {
    // The overwhelmingly common case: an ordinary session on an unclaimed
    // checkout. An absent holder means either nobody is there or the server
    // could not tell, and blocking on an unanswered question is how a guard
    // becomes an obstacle.
    const verdict = await entry?.predicate({ sessionId: "s1", tool: "Write" });
    expect(verdict?.triggered).toBe(false);
  });

  it("fires and names the holder when one is present", async () => {
    const verdict = await entry?.predicate({
      sessionId: "s1",
      tool: "Write",
      occupyingCrew: {
        rootSessionId: "root-theirs",
        itemId: "item-b",
        branch: "feat/x",
        lastActiveSecondsAgo: 30,
      },
    });
    expect(verdict?.triggered).toBe(true);
    // Naming the holder is the difference between a refusal a caller can
    // act on and one whose only available move is to override it.
    expect(verdict?.message).toContain("root-theirs");
    expect(verdict?.message).toContain("item-b");
    expect(verdict?.message).toContain("feat/x");
    expect(verdict?.message).toContain("30s ago");
  });

  it("does not fire inside a linked worktree", async () => {
    // `(machine, repo)` cannot distinguish two crews sharing one working
    // tree from two crews each in their own — and the second is the
    // intended arrangement, not a collision. Firing on it would refuse the
    // healthy case on every file edit, which is how a guard teaches a
    // session to distrust it.
    const verdict = await entry?.predicate({
      sessionId: "s1",
      tool: "Write",
      isLinkedWorktree: true,
      occupyingCrew: { rootSessionId: "root-theirs", itemId: "item-b" },
    });
    expect(verdict?.triggered).toBe(false);
  });

  it("fires when the working tree is unknown", async () => {
    // Strictly `true` suppresses. An absent field means the claim recorded
    // no worktree, and an unknown working tree is not a known-separate one
    // — the same reading of absence the rest of the catalogue uses.
    const verdict = await entry?.predicate({
      sessionId: "s1",
      tool: "Write",
      occupyingCrew: { rootSessionId: "root-theirs", itemId: "item-b" },
    });
    expect(verdict?.triggered).toBe(true);
  });

  it("still names the holder when the branch and activity are unknown", async () => {
    const verdict = await entry?.predicate({
      sessionId: "s1",
      occupyingCrew: { rootSessionId: "root-theirs", itemId: "item-b" },
    });
    expect(verdict?.triggered).toBe(true);
    expect(verdict?.message).toContain("root-theirs");
    // No dangling "on branch undefined" or "last active undefineds ago".
    expect(verdict?.message).not.toContain("undefined");
  });
});

describe("I13 — work recorded against no item", () => {
  // The entry with the most expensive incident behind it: a five-crew night
  // where the most valuable PR of the five was never minted as a task, and
  // nothing failed loudly because the board was being tracked in a person's
  // head. Each test below is written against a way this could be wrong
  // rather than against the happy path alone.

  it("fires on a commit from a session that holds nothing", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git commit -m 'the work'", holdsClaim: false },
    });

    expect(findings.map((finding) => finding.id)).toContain("work-recorded-against-no-item");
    // A nudge and not a block. An unminted commit is not a wrong commit —
    // in the incident it was the best work of the night — so refusing it
    // would delete the record rather than the mistake.
    expect(strongestLevel(findings)).toBe("nudge");
  });

  it("fires on a push as well as a commit", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git push origin feat/thing", holdsClaim: false },
    });

    expect(findings.map((finding) => finding.id)).toContain("work-recorded-against-no-item");
  });

  it("says nothing when the session holds an item", async () => {
    // The ordinary case, and by far the most common one. An entry that
    // fired here would fire on every commit a claimed builder makes, which
    // is the "fires and annoys" failure that earns a 1 on the owner's scale.
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git commit -m 'the work'", holdsClaim: true, itemId: "item-9" },
    });

    expect(findings).toEqual([]);
  });

  it("says nothing when nobody asked whether a claim exists", async () => {
    // **The distinction the entry is built on.** `holdsClaim` absent means
    // the lookup never ran — which is what the assembly gate does for most
    // calls — and is emphatically not the same as "asked, and it holds
    // nothing". A predicate keyed on `itemId === undefined` would read
    // these two the same way and fire on most calls in the system.
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git commit -m 'the work'" },
    });

    expect(findings).toEqual([]);
  });

  it("says nothing about the commit shapes that record nothing new", async () => {
    for (const command of ["git commit --amend --no-edit", "git commit --dry-run", "git status"]) {
      const findings = await evaluate({
        entries: BUILTIN_INTERVENTIONS,
        phase: "pre",
        context: { command, holdsClaim: false },
      });

      expect(findings, command).toEqual([]);
    }
  });

  it("names a remedy the caller can actually carry out", () => {
    // The rule PR #255 exists to enforce, applied to an intervention rather
    // than to an operation's advice. Five times in one month this
    // repository shipped a message naming a remedy that did not exist, and
    // the kill guard is the cautionary case — right on most firings and
    // catastrophic on the one where its message named a remedy it refused.
    const entry = BUILTIN_INTERVENTIONS.find(
      (candidate) => candidate.id === "work-recorded-against-no-item",
    );
    expect(entry).toBeDefined();

    // Both operations named are real, and neither is refused by this entry:
    // it is a nudge, so nothing is blocked, and `create_task` followed by
    // `claim` is a route the caller can walk from where it is standing.
    for (const message of [entry?.messages.plain, entry?.messages.prominent]) {
      expect(message).toContain("create_task");
    }
    expect(entry?.messages.prominent).toContain("claim");
  });
});

describe("I14 — an orchestrator that has become the builder", () => {
  const drifting = { claimedRole: "orchestrator", handsOnWork: "elevated" } as const;

  it("fires on an orchestrator accumulating edits", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "post",
      context: { ...drifting, itemId: "item-3" },
    });

    expect(findings.map((finding) => finding.id)).toContain("orchestrator-doing-the-work");
    expect(findings.find((f) => f.id === "orchestrator-doing-the-work")?.data).toEqual({
      itemId: "item-3",
    });
  });

  it("says nothing about a builder doing exactly the same editing", async () => {
    // The role is the entry. A builder making twenty edits is doing its
    // job, and this is the assertion that stops I14 from becoming a
    // general "you edited a lot of files" nudge.
    for (const claimedRole of ["builder", "reviewer", "scout"]) {
      const findings = await evaluate({
        entries: BUILTIN_INTERVENTIONS,
        phase: "post",
        context: { claimedRole, handsOnWork: "elevated" },
      });

      expect(findings, claimedRole).toEqual([]);
    }
  });

  it("treats an unknown reading as no finding, not as an elevated one", async () => {
    // `unknown` means too little evidence, and a session a few calls old
    // has established nothing. Reading it as elevated would nudge every
    // orchestrator on its opening moves — which is how a digest teaches
    // its reader to skip it.
    for (const handsOnWork of ["unknown", "normal"] as const) {
      const findings = await evaluate({
        entries: BUILTIN_INTERVENTIONS,
        phase: "post",
        context: { claimedRole: "orchestrator", handsOnWork },
      });

      expect(findings, handsOnWork).toEqual([]);
    }
  });

  it("cannot block, however it is configured", async () => {
    // A `post` entry describes a call that has already run. This is the
    // invariant rather than a property of the entry's own default.
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      overrides: { "orchestrator-doing-the-work": { level: "hard-block" } },
      phase: "post",
      context: drifting,
    });

    const finding = findings.find((f) => f.id === "orchestrator-doing-the-work");
    expect(finding?.level).toBe("nudge");
  });

  it("never fires on a pre event, so it cannot cost the blocking path", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: drifting,
    });

    expect(findings.map((finding) => finding.id)).not.toContain("orchestrator-doing-the-work");
  });

  it("names a remedy the caller can actually carry out", () => {
    const entry = BUILTIN_INTERVENTIONS.find(
      (candidate) => candidate.id === "orchestrator-doing-the-work",
    );
    expect(entry).toBeDefined();

    // Two routes, and the second matters: telling an orchestrator only to
    // "delegate" is unfollowable when it has already done the work. So the
    // message also offers releasing and re-claiming as a builder, which is
    // a real pair of operations and makes the board true either way.
    expect(entry?.messages.plain).toContain("release");
    expect(entry?.messages.prominent).toContain("release");
  });
});

describe("the catalogue entries that are deliberately not built", () => {
  it("records a reason for every unimplemented entry", () => {
    // The catalogue's instruction is to say so and stop when a situation
    // needs something the server cannot see. A bare id with no reason would
    // be the stopping without the saying.
    for (const entry of UNIMPLEMENTED_CATALOGUE_ENTRIES) {
      expect(entry.id, "id").toMatch(/^I\d+$/);
      expect(entry.missing.trim().length, entry.id).toBeGreaterThan(20);
    }
  });

  it("names each unimplemented entry exactly once", () => {
    // The failure this catches is a real one: an entry gets implemented and
    // its "why it is missing" line is left behind, so the file documents a
    // gap that closed. Both halves would look correct read on their own.
    const ids = UNIMPLEMENTED_CATALOGUE_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
  });

  it("accounts for every entry the catalogue document lists", () => {
    // Derived from `INTERVENTIONS.md` rather than compared against a
    // hardcoded count, because the catalogue is explicitly a growing list —
    // "new findings are appended here". A fixed number would fail on the
    // next appended entry and say only "expected 12, got 13", which reads
    // as this suite being stale rather than as the real finding: an entry
    // was catalogued and is in neither the registry nor the record of what
    // is deliberately unbuilt.
    const doc = readFileSync(new URL("../docs/plans/INTERVENTIONS.md", import.meta.url), "utf8");
    const catalogued = [...doc.matchAll(/^\| \*\*(I\d+)\*\* \|/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(catalogued.length, "no catalogue rows parsed").toBeGreaterThan(0);

    const accountedFor = new Set(UNIMPLEMENTED_CATALOGUE_ENTRIES.map((entry) => entry.id));
    // The built entries name themselves in their own summaries by id only in
    // the doc, so the mapping from a catalogue id to a shipped entry lives
    // here — the one place it can be checked rather than assumed.
    const BUILT_AS: Readonly<Record<string, string>> = {
      I1: "finished-with-no-reviewer",
      I7: "review-without-approval-at-tip",
      I10: "merge-without-approval-at-tip",
      I11: "broad-git-add-on-shared-checkout",
      I12: "broad-process-kill",
      I13: "work-recorded-against-no-item",
      I14: "orchestrator-doing-the-work",
      I15: "checkout-held-by-another-crew",
    };
    const shipped = new Set(BUILTIN_INTERVENTIONS.map((entry) => entry.id));

    for (const id of catalogued) {
      const builtId = BUILT_AS[id];
      if (builtId !== undefined) {
        expect(shipped, `${id} claims to be built`).toContain(builtId);
        expect(accountedFor.has(id), `${id} is both built and listed unbuilt`).toBe(false);
        continue;
      }
      expect(accountedFor.has(id), `${id} is catalogued but unaccounted for`).toBe(true);
    }

    expect(Object.keys(BUILT_AS).length + accountedFor.size).toBe(catalogued.length);
  });
});
