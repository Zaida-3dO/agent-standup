// The delivery-flow nudges — I26 (committed with no pull request), I27 (a
// pull request nobody asked for a review of) and I28 (a nits verdict whose
// findings nothing is tracking).
//
// **The negative controls are the point of this file.** All three are
// nudges, so the risk is not a wrongly-blocked call but a wrongly-nudged
// one — and an entry that fires on the ordinary case teaches its reader to
// skip the digest, which is the failure the scoring scale scores a 1. A
// firing nothing has rated carries no evidence either way, so an entry that
// cannot be shown to stay quiet is a liability rather than coverage.
//
// So each block below is written in two halves: what fires, and the
// near-miss that must not. The second half is the one doing the work.

import { describe, expect, it } from "vitest";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { isPullRequestOpen } from "@/lib/interventions/commands";
import { needs } from "@/lib/interventions/context";
import { assertRegistryValid, resolveLevel } from "@/lib/interventions/registry";
import type { Intervention, InterventionContext } from "@/lib/interventions/types";

function entry(id: string): Intervention {
  const found = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no builtin entry ${id}`);
  return found;
}

async function fires(id: string, context: InterventionContext): Promise<boolean> {
  return (await entry(id).predicate(context)).triggered;
}

describe("I26 — committed work with no pull request", () => {
  const ID = "committed-with-no-pull-request";

  it("fires on the stage it is about", async () => {
    expect(await fires(ID, { deliveryStage: "committed" })).toBe(true);
  });

  it("goes quiet once a pull request exists", async () => {
    // The incident this entry comes from is a branch that never became a
    // pull request. The moment one exists the situation is resolved, and an
    // entry that kept firing afterwards would nag for the life of the item
    // — which is how a guard earns a 1 and gets switched off.
    expect(await fires(ID, { deliveryStage: "pull_request_open" })).toBe(false);
    expect(await fires(ID, { deliveryStage: "review_requested" })).toBe(false);
  });

  it("says nothing about an item with no commit at all", async () => {
    // The single most important negative here. An item nobody has committed
    // to has not stalled on its way to a pull request; it is mid-build, and
    // that is most of an item's working life. Absent is "not known", never
    // licence to guess.
    expect(await fires(ID, {})).toBe(false);
    expect(await fires(ID, { itemId: "i1", itemState: "executing" })).toBe(false);
  });

  it("carries the item id so the nudge can name what it is about", async () => {
    const verdict = await entry(ID).predicate({ deliveryStage: "committed", itemId: "i1" });
    expect(verdict.data).toEqual({ itemId: "i1" });
  });

  it("names the remedy rather than only the problem", async () => {
    // A nudge that says "this is wrong" without saying what to do is one
    // the reader cannot act on. Both messages must offer the parked case an
    // answer that is not "open a pull request you did not want".
    for (const message of Object.values(entry(ID).messages)) {
      expect(message).toMatch(/pull request/i);
      expect(message).toMatch(/waiting on/i);
    }
  });
});

describe("I27 — a pull request nobody requested a review of", () => {
  const ID = "pull-request-with-no-review-requested";

  it("fires once a pull request exists and nothing has asked for a review", async () => {
    expect(await fires(ID, { deliveryStage: "pull_request_open" })).toBe(true);
  });

  it("goes quiet once a review has been requested", async () => {
    expect(await fires(ID, { deliveryStage: "review_requested" })).toBe(false);
  });

  it("does not fire before the pull request exists", async () => {
    // I26's territory, not this one's. The two entries must not both fire
    // on one situation, or a single stalled item produces two nudges
    // saying different things.
    expect(await fires(ID, { deliveryStage: "committed" })).toBe(false);
    expect(await fires(ID, {})).toBe(false);
  });

  it("treats an out-of-band reviewer as an answer rather than an error", async () => {
    // The known false positive, named in the entry: a reviewer dispatched
    // without `request_review` being called. The message has to accept that
    // case, because telling a caller they are wrong when they are not is
    // what trains people to ignore the channel.
    expect(entry(ID).messages.prominent).toMatch(/out of band/i);
  });
});

describe("I28 — a nits verdict whose findings nothing is tracking", () => {
  const ID = "nits-merged-with-nothing-tracking-them";

  it("fires when a nits verdict left findings behind", async () => {
    expect(await fires(ID, { untrackedNits: { findingCount: 9 } })).toBe(true);
  });

  it("says nothing when the review recorded no findings", async () => {
    // A nits verdict with nothing recorded has nothing to lose. The count
    // is the signal, not the verdict — firing on the verdict alone would
    // nudge every clean `lgtm_with_nits`, which is the common case.
    expect(await fires(ID, { untrackedNits: { findingCount: 0 } })).toBe(false);
  });

  it("says nothing when the server did not look", async () => {
    expect(await fires(ID, {})).toBe(false);
    expect(await fires(ID, { itemId: "i1", itemState: "merged" })).toBe(false);
  });

  it("reports the count, because the number is the whole sentence", async () => {
    // "Nine findings" is a different sentence from "a finding", and the
    // message's job is to say which.
    const verdict = await entry(ID).predicate({
      untrackedNits: { findingCount: 9, reviewRound: 2 },
      itemId: "i1",
    });
    expect(verdict.data).toEqual({ findingCount: 9, itemId: "i1", reviewRound: 2 });
  });

  it("offers three complete answers, not just a demand for a row", async () => {
    // The accepted false positive is nits actioned inside the same change,
    // which nothing records. Demanding a linked item would push callers to
    // mint bookkeeping rows for work already done — how a guard teaches its
    // users to route around it.
    expect(entry(ID).messages.plain).toMatch(/actioned/i);
    expect(entry(ID).messages.plain).toMatch(/not worth doing/i);
  });
});

describe("none of the three can ever block", () => {
  it("is enforced by the registry, not merely by how they are written", () => {
    // A `post` entry with a blocking default throws at registration, and a
    // blocking override is clamped. Asserting the clamp here rather than
    // trusting the declaration is the difference between a property and a
    // convention: holding finished work hostage to bookkeeping would be
    // wrong even if the phase permitted it.
    for (const id of [
      "committed-with-no-pull-request",
      "pull-request-with-no-review-requested",
      "nits-merged-with-nothing-tracking-them",
    ]) {
      expect(entry(id).phase).toBe("post");
      expect(resolveLevel(entry(id).phase, "hard-block")).toBe("nudge");
      expect(resolveLevel(entry(id).phase, "block-overridable")).toBe("nudge");
    }
    // And the whole registry still validates with the three added.
    expect(() => assertRegistryValid(BUILTIN_INTERVENTIONS)).not.toThrow();
  });
});

describe("the gate that decides whether any of this is looked up", () => {
  // The property these three entries are most likely to break is not
  // correctness but cost: `hook_decision` is the highest-volume path in the
  // system, and a gate keyed on the phase alone would put a claim lookup
  // behind every `Read` and every `git status` on `PostToolUse` — roughly
  // half of all hook events.

  it("stays off the ordinary read traffic", () => {
    for (const call of [
      { command: "ls -la", tool: "Bash" },
      { command: "git status", tool: "Bash" },
      { command: "npm test", tool: "Bash" },
      { command: undefined, tool: "Read" },
    ]) {
      expect(needs(call.command, call.tool, "post").delivery, `${call.command ?? call.tool}`).toBe(
        false,
      );
    }
  });

  it("turns on for the calls that actually move the work along", () => {
    expect(needs("git commit -m 'x'", "Bash", "post").delivery).toBe(true);
    expect(needs("git push origin feat/x", "Bash", "post").delivery).toBe(true);
    expect(needs("gh pr create --fill", "Bash", "post").delivery).toBe(true);
    expect(needs(undefined, "Edit", "post").delivery).toBe(true);
  });

  it("never turns on for the pre phase", () => {
    // These are `post` nudges about work that has stopped moving, so none
    // can ever be the reason a call is allowed or refused. Reading them on
    // `pre` would put queries on the blocking path for no possible finding.
    expect(needs("git commit -m 'x'", "Bash", "pre").delivery).toBe(false);
    expect(needs("git push origin feat/x", "Bash", "pre").delivery).toBe(false);
    expect(needs(undefined, "Edit", "pre").delivery).toBe(false);
    // And with no phase stated at all, which the assembler reads as `pre`.
    expect(needs("git commit -m 'x'", "Bash", undefined).delivery).toBe(false);
  });

  it("recognises opening a pull request without catching the reads around it", () => {
    expect(isPullRequestOpen("gh pr create --fill")).toBe(true);
    expect(isPullRequestOpen("gh pr create --title x --body y")).toBe(true);
    // The reads a session runs constantly. Matching `gh pr` alone would put
    // a query behind every status check in the merge loop.
    expect(isPullRequestOpen("gh pr view 12")).toBe(false);
    expect(isPullRequestOpen("gh pr list")).toBe(false);
    expect(isPullRequestOpen("gh pr checks")).toBe(false);
    expect(isPullRequestOpen("echo gh pr create")).toBe(false);
  });

  it("turns on at the merge, which is the moment I28 is about", () => {
    // The defect this replaced: the gate covered commit/push/`gh pr create`
    // and stopped short of the close, so I28 fired while a row was still
    // being worked and went silent at the exact event where its findings
    // stop being visible. Each of these is `false` without the
    // `isMergeLanding` clause.
    expect(needs("gh pr merge 61 --squash", "Bash", "post").delivery).toBe(true);
    expect(needs("gh pr merge 61 --merge --delete-branch", "Bash", "post").delivery).toBe(true);
    expect(needs("git merge origin/main", "Bash", "post").delivery).toBe(true);
    expect(needs("git merge --no-ff feature", "Bash", "post").delivery).toBe(true);
  });

  it("stays off `git pull`, which catches up rather than closing", () => {
    // **The negative control that decided the shape of the fix.** The
    // obvious implementation reuses `isMergeAttempt`, which also matches a
    // bare `git pull` — correct for the approval limb, wrong here. A pull
    // is the opposite of a close: nothing lands, so no finding can become
    // invisible, and it is the highest-frequency git command a session
    // runs. Catching it would put the assignment and artifact lookups on
    // that path for zero possible findings.
    //
    // This case fails if anyone later "simplifies" the clause back to
    // `isMergeAttempt`, which is precisely why it is written by name.
    expect(needs("git pull", "Bash", "post").delivery).toBe(false);
    expect(needs("git pull --ff-only", "Bash", "post").delivery).toBe(false);
    expect(needs("git pull origin main", "Bash", "post").delivery).toBe(false);
    expect(needs("git pull --no-ff origin main", "Bash", "post").delivery).toBe(false);
  });

  it("stays off the merge shapes that land nothing", () => {
    // Finishing or discarding a merge already in progress, and the
    // fast-forward that only moves a pointer. None of them closes a row.
    expect(needs("git merge --abort", "Bash", "post").delivery).toBe(false);
    expect(needs("git merge --continue", "Bash", "post").delivery).toBe(false);
    expect(needs("git merge --quit", "Bash", "post").delivery).toBe(false);
    expect(needs("git merge --ff-only origin/main", "Bash", "post").delivery).toBe(false);
    // The reads a session runs while watching its own PR.
    expect(needs("gh pr view 61", "Bash", "post").delivery).toBe(false);
    expect(needs("gh pr checks 61", "Bash", "post").delivery).toBe(false);
    // Not a merge at all, and the shapes that merely mention one.
    expect(needs("git merge-base main HEAD", "Bash", "post").delivery).toBe(false);
    expect(needs("echo gh pr merge 61", "Bash", "post").delivery).toBe(false);
  });

  it("never turns the merge on at the pre phase", () => {
    // `pre` is the blocking path. I28 is a `post` nudge, so reading it here
    // would add queries to the path that decides whether a call proceeds,
    // for a finding that could never be the reason.
    expect(needs("gh pr merge 61 --squash", "Bash", "pre").delivery).toBe(false);
    expect(needs("git merge origin/main", "Bash", "pre").delivery).toBe(false);
    // And the approval limb the merge DOES feed is untouched by all this.
    expect(needs("gh pr merge 61 --squash", "Bash", "pre").approval).toBe(true);
    expect(needs("git pull", "Bash", "pre").approval).toBe(true);
  });
});
