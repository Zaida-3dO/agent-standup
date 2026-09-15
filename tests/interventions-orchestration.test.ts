// The orchestration nudges — I23 (squash-merge awareness), I24 (rebase
// restraint) and I25 (batching visual reviews).
//
// All three are nudges, so the risk they carry is not a wrongly-blocked
// call but a wrongly-nudged one: an entry that fires on the ordinary case
// teaches the reader to skip it, which is the failure the owner's own
// scoring scale scores a 1. So each block below is written in two halves —
// what fires, and the near-miss that must not — and the second half is the
// one doing the work.

import { describe, expect, it } from "vitest";
import { isMergedByRefComparison, isRebaseOrDivergenceCheck } from "@/lib/interventions/commands";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import type { Intervention, InterventionContext } from "@/lib/interventions/types";

function entry(id: string): Intervention {
  const found = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no builtin entry ${id}`);
  return found;
}

async function fires(id: string, context: InterventionContext): Promise<boolean> {
  return (await entry(id).predicate(context)).triggered;
}

describe("I23 — a merged check by ref comparison", () => {
  it.each([
    "git branch --merged main",
    "git branch --no-merged",
    "git merge-base --is-ancestor feat main",
    "git cherry main feat",
    "git log main..feat",
    "git rev-list main..feat",
    "git -C /some/repo log main..feat",
  ])("recognises %s", (command) => {
    expect(isMergedByRefComparison(command)).toBe(true);
  });

  it.each([
    // Ordinary reads a session runs constantly. Nudging on these would
    // nudge on nearly every call.
    "git log --oneline -5",
    "git status",
    "git diff main",
    "git branch",
    "git merge-base main feat",
    // Not git at all.
    "echo git branch --merged",
    "grep -r 'git cherry' docs/",
  ])("does not recognise %s", (command) => {
    expect(isMergedByRefComparison(command)).toBe(false);
  });

  it("fires on a recognised command and stays silent otherwise", async () => {
    expect(await fires("merged-check-by-ref-comparison", { command: "git cherry main" })).toBe(
      true,
    );
    expect(await fires("merged-check-by-ref-comparison", { command: "git status" })).toBe(false);
    // No command at all — a Write, an Edit. Nothing to read, nothing to say.
    expect(await fires("merged-check-by-ref-comparison", {})).toBe(false);
  });

  it("explains why the output will mislead, not merely that it will", async () => {
    // A nudge that says "this is wrong" without saying why is one the
    // reader cannot act on and will not trust twice.
    const messages = entry("merged-check-by-ref-comparison").messages;
    expect(messages.plain).toMatch(/squash/i);
    expect(messages.prominent).toMatch(/squash/i);
  });
});

describe("I24 — rebase restraint", () => {
  it.each([
    "git rebase main",
    "git rebase -i HEAD~3",
    "git pull --rebase origin main",
    "git merge-tree main feat",
    "git merge --no-commit --no-ff main",
  ])("recognises %s", (command) => {
    expect(isRebaseOrDivergenceCheck(command)).toBe(true);
  });

  it.each([
    // Finishing or abandoning a rebase already under way: the decision this
    // speaks to was made some time ago, and nudging here would nudge
    // hardest at the caller already cleaning up.
    "git rebase --abort",
    "git rebase --continue",
    "git rebase --skip",
    // What every session runs to orient itself.
    "git fetch origin",
    "git status",
    "git pull origin main",
    // A real merge is I10's business, not this entry's.
    "git merge main",
  ])("does not recognise %s", (command) => {
    expect(isRebaseOrDivergenceCheck(command)).toBe(false);
  });

  it("fires on a rebase and stays silent on an abort", async () => {
    expect(
      await fires("rebase-before-checking-for-conflicts", { command: "git rebase main" }),
    ).toBe(true);
    expect(
      await fires("rebase-before-checking-for-conflicts", { command: "git rebase --abort" }),
    ).toBe(false);
  });

  it("names fixing forward as the default, which is the whole advice", async () => {
    const messages = entry("rebase-before-checking-for-conflicts").messages;
    expect(messages.plain).toMatch(/forward/i);
    expect(messages.prominent).toMatch(/forward/i);
    // And says what DOES warrant a rebase, so the nudge is actionable
    // rather than merely discouraging.
    expect(messages.plain).toMatch(/conflict/i);
  });
});

describe("I25 — visual reviews in flight concurrently", () => {
  it("fires when several are pending", async () => {
    expect(await fires("visual-reviews-in-flight-concurrently", { pendingVisualReviews: 4 })).toBe(
      true,
    );
  });

  it("stays silent at one, which is a review rather than a batch", async () => {
    expect(await fires("visual-reviews-in-flight-concurrently", { pendingVisualReviews: 1 })).toBe(
      false,
    );
  });

  it("stays silent at zero", async () => {
    expect(await fires("visual-reviews-in-flight-concurrently", { pendingVisualReviews: 0 })).toBe(
      false,
    );
  });

  it("stays silent when the server did not count", async () => {
    // Absent is "cannot tell", which is not zero and must not be read as a
    // reason to fire — nor as a reason to stay silent by accident.
    expect(await fires("visual-reviews-in-flight-concurrently", {})).toBe(false);
  });

  it("reports the count it fired on", async () => {
    const verdict = await entry("visual-reviews-in-flight-concurrently").predicate({
      pendingVisualReviews: 3,
    });
    expect(verdict.data).toEqual({ pendingVisualReviews: 3 });
  });

  it("names the deferral affordance, not just the advice to batch", async () => {
    // The owner asked for a first-class way to record "review deferred
    // because of concurrency". Advice to defer with no way to record it is
    // advice to forget it, so the message has to carry the affordance.
    const messages = entry("visual-reviews-in-flight-concurrently").messages;
    expect(messages.plain).toMatch(/link|minted/i);
    expect(messages.prominent).toMatch(/link|minted/i);
  });
});

describe("all three are nudges, and stay that way", () => {
  it.each([
    "merged-check-by-ref-comparison",
    "rebase-before-checking-for-conflicts",
    "visual-reviews-in-flight-concurrently",
  ])("%s never blocks", (id) => {
    // None of these describes something wrong — only something more
    // expensive than it needs to be. Blocking any of them would refuse a
    // command that was fine.
    expect(entry(id).defaultLevel).toBe("nudge");
  });
});

// ── I29 — dispatching into a crew that is already wide ─────────────────
//
// The threshold is the whole entry. The owner's trigger is "more than 2
// crews at the same time", and two is the ordinary shape — a builder and a
// reviewer, or two independent tasks — so an off-by-one here nudges the
// common case and teaches the reader to skip the message. Each case below
// names the mutation it catches.
describe("I29 — dispatching into a wide crew", () => {
  it("fires at three items in flight", async () => {
    expect(await fires("dispatching-into-a-wide-crew", { concurrentCrewItems: 3 })).toBe(true);
  });

  it("is silent at two, which is the ordinary shape", async () => {
    // Changing `< 3` to `< 2` in the predicate passes every other case in
    // this file and fails this one.
    expect(await fires("dispatching-into-a-wide-crew", { concurrentCrewItems: 2 })).toBe(false);
  });

  it("is silent at one, and at none in flight", async () => {
    expect(await fires("dispatching-into-a-wide-crew", { concurrentCrewItems: 1 })).toBe(false);
    expect(await fires("dispatching-into-a-wide-crew", { concurrentCrewItems: 0 })).toBe(false);
  });

  it("is silent when the server did not count", async () => {
    // Absent is not zero and is not a width. Reading `undefined` as a
    // number would make this fire on every dispatch the gate did not
    // answer for, which is most of them.
    expect(await fires("dispatching-into-a-wide-crew", {})).toBe(false);
  });

  it("carries the width it found, so the message can be checked against it", async () => {
    const verdict = await entry("dispatching-into-a-wide-crew").predicate({
      concurrentCrewItems: 5,
    });
    expect(verdict.data).toEqual({ concurrentCrewItems: 5 });
  });

  it("asks about territory and about review capacity, which are the two failures", async () => {
    // The owner recorded the trigger without an action, so the remedy is
    // this entry's own proposal — and a message that named neither failure
    // would be the "reminder in the abstract" the catalogue warns against.
    const messages = entry("dispatching-into-a-wide-crew").messages;
    expect(messages.plain).toMatch(/territor|overlap/i);
    expect(messages.plain).toMatch(/review/i);
    expect(messages.prominent).toMatch(/territor|overlap/i);
    expect(messages.prominent).toMatch(/review/i);
  });

  it("never blocks a dispatch", async () => {
    // Parallelism is the point of the mechanism. Refusing a dispatch on
    // width alone would refuse the thing the system is for.
    expect(entry("dispatching-into-a-wide-crew").defaultLevel).toBe("nudge");
  });

  // The worktree half, per the owner's correction: "I think this should
  // only be if those 3 are on the same worktree... there's no need to be
  // cautious if they are on separate worktrees." Three outcomes rather than
  // two, and the third - the check could not be completed - is the one a
  // careless implementation silently loses.
  describe("territory", () => {
    const WIDE = 4;

    it("is silent at width when every crew is in its own worktree", async () => {
      // The owner's case. Three crews in three trees cannot commit over
      // each other, so the territory advice has nothing to say to them.
      expect(
        await fires("dispatching-into-a-wide-crew", {
          concurrentCrewItems: WIDE,
          crewTerritory: { sharedTrees: [], unrecordedWorktrees: 0 },
        }),
      ).toBe(false);
    });

    it("fires when two items share one tree", async () => {
      expect(
        await fires("dispatching-into-a-wide-crew", {
          concurrentCrewItems: WIDE,
          crewTerritory: {
            sharedTrees: [{ worktree: "C:/repo/wt", itemIds: ["i1", "i2"] }],
            unrecordedWorktrees: 0,
          },
        }),
      ).toBe(true);
    });

    it("still fires when a claim recorded no worktree, which is not disjoint", async () => {
      // The load-bearing case. `worktree` is optional on `claim`, so an
      // empty `sharedTrees` has two causes: nothing overlaps, or the
      // comparison could not be made. Reading the second as the first
      // silences the entry exactly where it knows least - and a predicate
      // keyed on `sharedTrees.length === 0` alone passes every other case
      // in this block and fails this one.
      expect(
        await fires("dispatching-into-a-wide-crew", {
          concurrentCrewItems: WIDE,
          crewTerritory: { sharedTrees: [], unrecordedWorktrees: 2 },
        }),
      ).toBe(true);
    });

    it("stays silent below the threshold however the trees overlap", async () => {
      // Territory does not override the width gate. A builder and its
      // reviewer sharing one tree is the correct shape, not a collision.
      expect(
        await fires("dispatching-into-a-wide-crew", {
          concurrentCrewItems: 2,
          crewTerritory: {
            sharedTrees: [{ worktree: "C:/repo/wt", itemIds: ["i1", "i2"] }],
            unrecordedWorktrees: 0,
          },
        }),
      ).toBe(false);
    });

    it("names the tree and the items sharing it", async () => {
      // A nudge that says "something overlaps" without saying what is the
      // reminder in the abstract the catalogue warns against.
      const verdict = await entry("dispatching-into-a-wide-crew").predicate({
        concurrentCrewItems: WIDE,
        crewTerritory: {
          sharedTrees: [{ worktree: "C:/repo/wt", itemIds: ["i1", "i2"] }],
          unrecordedWorktrees: 0,
        },
      });
      expect(verdict.data).toEqual({
        concurrentCrewItems: WIDE,
        sharedTrees: [{ worktree: "C:/repo/wt", itemIds: ["i1", "i2"] }],
        unrecordedWorktrees: 0,
      });
    });

    it("fires on width alone when territory was never examined", async () => {
      // Absent `crewTerritory` is "not looked at", which must not be read
      // as "separate trees" - that would silence the entry wholesale on
      // every path that does not assemble it.
      expect(await fires("dispatching-into-a-wide-crew", { concurrentCrewItems: WIDE })).toBe(true);
    });

    it("tells the reader when it is safe to disregard", async () => {
      // The owner's fallback ask, which the message must carry even now
      // that the predicate implements the real check - the entry still
      // fires when worktrees went unrecorded, and that reader needs to know
      // the finding may not apply to them.
      const messages = entry("dispatching-into-a-wide-crew").messages;
      expect(messages.plain).toMatch(/worktree/i);
      expect(messages.prominent).toMatch(/worktree/i);
    });
  });
});

// I32 - crew in flight with nobody checking in.
//
// The entry the `wait_for_crew` crew declined to write because the signal
// did not exist. What makes it honest is the distinction between a counted
// zero and an uncounted absence, so that is what most of these cases pin.
describe("I32 - crew in flight without a check-in", () => {
  const ID = "crew-in-flight-without-check-in";

  it("fires when crew are running", async () => {
    expect(await fires(ID, { crewInFlight: 2 })).toBe(true);
  });

  it("fires for a single crew member", async () => {
    // The boundary. A predicate written `> 1` passes the case above and
    // fails this one, and one crewmate working alone is the commonest
    // shape there is.
    expect(await fires(ID, { crewInFlight: 1 })).toBe(true);
  });

  it("is silent at a counted zero, because the crew has come home", async () => {
    expect(await fires(ID, { crewInFlight: 0 })).toBe(false);
  });

  it("is silent when the count was never taken", async () => {
    // The acceptance criterion this entry was blocked on: absent means
    // "not known", which a well-written predicate answers with
    // `triggered: false` rather than by guessing. A session whose crew
    // state could not be determined must not be nudged.
    expect(await fires(ID, {})).toBe(false);
  });

  it("does not fire on being an orchestrator alone", async () => {
    // The failure this row exists to avoid, stated as a test: gating on
    // `isOrchestrator` would fire on every orchestrator on every call
    // regardless of whether anything was running.
    expect(await fires(ID, { isOrchestrator: true })).toBe(false);
    expect(await fires(ID, { isOrchestrator: true, crewInFlight: 0 })).toBe(false);
  });

  it("points at the command that actually exists", async () => {
    // `standup crew wait` was merged as c8d4cc5, which is what makes this
    // advice actionable rather than aspirational. A message naming no
    // remedy is a complaint.
    for (const message of Object.values(entry(ID).messages)) {
      expect(message).toMatch(/standup crew wait/);
    }
  });

  it("carries the count so the message can be checked against it", async () => {
    const verdict = await entry(ID).predicate({ crewInFlight: 3 });
    expect(verdict.data).toEqual({ crewInFlight: 3 });
  });

  it("is a nudge addressed to the orchestrator, on the digest", async () => {
    // Only the orchestrator can start a wait, so addressing the builder
    // would be asking it to act outside its remit. The digest because crew
    // running now will still be running in five minutes.
    expect(entry(ID).defaultLevel).toBe("nudge");
    expect(entry(ID).audience).toBe("orchestrator");
    expect(entry(ID).defaultTiming).toBe("digest");
    expect(entry(ID).phase).toBe("post");
  });
});

// ── I30 — a visual review deferred to nowhere ──────────────────────────
//
// The predicate is a single boolean because the conjunction is computed in
// the assembler, so what these pin is the reading of that boolean: strictly
// true, with absent and false both silent. The three-limb condition itself
// is asserted against real rows in the db-backed flow-nudge suite.
describe("I30 — a visual review deferred without a record", () => {
  it("fires when the item closed with neither a review nor a link", async () => {
    expect(
      await fires("visual-review-deferred-without-record", {
        visualReviewDeferredUnrecorded: true,
        itemId: "i-1",
      }),
    ).toBe(true);
  });

  it("is silent when the question was asked and the item is fine", async () => {
    expect(
      await fires("visual-review-deferred-without-record", {
        visualReviewDeferredUnrecorded: false,
      }),
    ).toBe(false);
  });

  it("is silent when the server did not look", async () => {
    // Absent is not a deferral. Relaxing the predicate's `!== true` to a
    // truthiness check fires this on every post-phase call on an item the
    // delivery gate never asked about.
    expect(await fires("visual-review-deferred-without-record", {})).toBe(false);
  });

  it("carries the item id so the finding is addressable", async () => {
    const verdict = await entry("visual-review-deferred-without-record").predicate({
      visualReviewDeferredUnrecorded: true,
      itemId: "i-7",
    });
    expect(verdict.data).toEqual({ itemId: "i-7" });
  });

  it("accepts 'not needed' as an answer rather than demanding a follow-up", async () => {
    // The point is that the deferral is *recorded*, not that a row must be
    // minted. A message demanding an item would push callers to mint
    // bookkeeping rows for reviews they had correctly decided to skip.
    const messages = entry("visual-review-deferred-without-record").messages;
    expect(messages.plain).toMatch(/not needed/i);
    expect(messages.prominent).toMatch(/not needed/i);
  });

  it("never blocks", async () => {
    expect(entry("visual-review-deferred-without-record").defaultLevel).toBe("nudge");
  });
});

// ── I31 — asking the person before trying to answer it ─────────────────
//
// This entry was argued against on the grounds that judging a question's
// justification requires reading intent, and that a false positive is
// invisible to both parties. It ships because the owner's answer is
// measurement rather than detection: log the firing and the split between
// "worked it out alone" and "asked anyway, correctly". So what these pin is
// not accuracy — the entry makes no accuracy claim — but the two properties
// that make it safe: it never blocks, and it asks for the rating that is
// the whole justification for having it.
describe("I31 — asking without trying first", () => {
  it("fires when the session is putting a question to the person", async () => {
    expect(await fires("asking-without-trying-first", { isAskingUser: true })).toBe(true);
  });

  it("is silent on every call that is not a question", async () => {
    expect(await fires("asking-without-trying-first", {})).toBe(false);
    expect(await fires("asking-without-trying-first", { tool: "Bash", command: "ls" })).toBe(false);
    expect(await fires("asking-without-trying-first", { isAskingUser: false })).toBe(false);
  });

  it("never blocks, because a suppressed question is invisible to both parties", async () => {
    // **The load-bearing assertion.** A false positive on a block
    // suppresses a question nobody ever learns was wanted, and it would
    // also destroy the outcome split that justifies the entry existing —
    // the split is only observable if the agent stays free to ask.
    // Changing `defaultLevel` to either blocking level fails here.
    const level = entry("asking-without-trying-first").defaultLevel;
    expect(level).toBe("nudge");
    expect(["block-overridable", "hard-block"]).not.toContain(level);
  });

  it("asks for the rating that makes the entry measurable", async () => {
    // Ope's condition for building this at all was logging the split
    // between questions that were needed and questions that were not.
    // A message that did not ask for the rating would leave the entry
    // exactly as unmeasurable as the original objection said it was.
    const messages = entry("asking-without-trying-first").messages;
    expect(messages.plain).toContain("score_intervention");
    expect(messages.prominent).toContain("score_intervention");
  });

  it("still tells the reader when asking is right", async () => {
    // A nudge that only discouraged asking would suppress the questions
    // that genuinely need a person — unsafe, irreversible, or theirs to
    // decide. Naming those is what keeps this advice rather than pressure.
    const messages = entry("asking-without-trying-first").messages;
    expect(messages.plain).toMatch(/unsafe|irreversible/i);
    expect(messages.prominent).toMatch(/unsafe|irreversible/i);
  });

  it("names concrete things to try, not a generic reminder", async () => {
    const messages = entry("asking-without-trying-first").messages;
    expect(messages.prominent).toMatch(/brief/i);
    expect(messages.prominent).toMatch(/ambigu/i);
  });
});

// I16, nudge-level. The catalogued entry is block-overridable and stays
// unbuilt for want of a directory-size signal the server cannot see; this is
// the shape-only half the owner asked for explicitly.
//
// **This fires on more traffic than anything else in the catalogue**, so the
// cases that matter most are the ones asserting it stays quiet.
describe("I16 (nudge) - an unscoped recursive search", () => {
  const ID = "unscoped-recursive-search";

  it("fires on a recursive search with nothing narrowing it", () => {
    return expect(fires(ID, { command: "rg TODO" })).resolves.toBe(true);
  });

  it("is silent when the search names a path", async () => {
    expect(await fires(ID, { command: "rg TODO src/lib" })).toBe(false);
  });

  it("is silent when the search is bounded by a glob or type", async () => {
    expect(await fires(ID, { command: "rg TODO -g '*.ts'" })).toBe(false);
    expect(await fires(ID, { command: "rg TODO --type ts" })).toBe(false);
  });

  it("is silent when no command was reported", async () => {
    // Absent is "not known", never a match. A predicate reading undefined as
    // a searchable string would fire on every call carrying no command.
    expect(await fires(ID, {})).toBe(false);
  });

  it("is silent on ordinary non-search traffic", async () => {
    for (const command of ["ls -la", "git status", "npm test"]) {
      expect(await fires(ID, { command }), command).toBe(false);
    }
  });

  it("never refuses the search", async () => {
    // The catalogued entry is block-overridable because it would have a size
    // signal to justify refusing. Without one a block would refuse correct
    // work routinely, and the owner asked for a nudge. Raising this level is
    // the change this case exists to catch.
    expect(entry(ID).defaultLevel).toBe("nudge");
    expect(entry(ID).audience).toBe("agent");
    expect(entry(ID).phase).toBe("pre");
  });

  it("fires immediately, because the advice expires with the command", async () => {
    // A nudge arriving on the next digest is advice about a search that has
    // already finished - the turn it would have saved is spent.
    expect(entry(ID).defaultTiming).toBe("immediate");
  });

  it("names the cheaper move rather than only objecting", async () => {
    // A nudge that says "this may be slow" without saying what to do
    // instead is a complaint.
    for (const message of Object.values(entry(ID).messages)) {
      expect(message).toMatch(/ls /);
      expect(message).toMatch(/scope|subdirector/i);
    }
  });

  it("asks the reader to rate it, so its own keep-or-retire call has data", async () => {
    // This is the entry most likely to be judged noise, and that is now a
    // measurable question rather than an argument.
    for (const message of Object.values(entry(ID).messages)) {
      expect(message).toMatch(/rate this nudge/i);
    }
  });
});
