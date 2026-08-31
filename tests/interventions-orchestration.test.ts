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
