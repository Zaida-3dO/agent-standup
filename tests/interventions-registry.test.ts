// MILESTONES.md #128 — the intervention registry's shape
// (`src/lib/interventions/`).
//
// This is a skeleton, so what is worth testing is the *contract* the
// eventual catalogue and the eventual custom entries will be held to, not
// the two example entries' detections. Four properties, each with the change
// that breaks it:
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
import { describe, expect, it, vi } from "vitest";
import {
  InterventionRegistryError,
  assertRegistryValid,
  evaluate,
  resolveLevel,
  resolveTiming,
  strongestLevel,
} from "@/lib/interventions/registry";
import { BUILTIN_INTERVENTIONS, isBroadGitAdd } from "@/lib/interventions/builtins";
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

    expect(() => assertRegistryValid([entry({ phase: "post", defaultLevel: "hard-block" })])).toThrow(
      /cannot refuse it/,
    );
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
      entries: [entry({ id: "b", phase: "pre", defaultLevel: "hard-block", defaultTiming: "digest" })],
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
      context: { itemState: "in_review", hasApprovalAtTip: false, itemId: 42 },
      // Configured as strongly as the settings page allows. It is still a nudge.
      overrides: { "review-without-approval-at-tip": { level: "hard-block" } },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("nudge");
    expect(findings[0]?.data).toEqual({ itemId: 42 });
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
