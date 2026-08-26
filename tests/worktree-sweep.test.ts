// Covers the guards that stop `scripts/sweep-worktrees.mjs` deleting a
// worktree that still holds work.
//
// The danger in the fix is bigger than the leak it fixes. Cleanup here means
// deleting directories other agents are working in, and on 2026-08-25 a crew
// lost roughly 200 lines to a single `git checkout` while a reviewer
// destroyed two scratch databases that were not its own. So these tests
// assert just as hard on what the sweep must NOT remove as on what it may.
//
// Two of them exist because of a specific defect shape this repo keeps
// hitting: a guard that cannot determine an answer returning the PERMISSIVE
// one. The first version of this sweep had a process check that crashed on
// every iteration and therefore protected nothing, and the version reviewed
// on PR #295 treated an empty process snapshot as "no processes are
// running". Both read as green. `looksLikeProcessList` is the fix, and the
// tests below are what stop it regressing.
import { describe, expect, it } from "vitest";

import {
  hasLiveProcess,
  looksLikeProcessList,
  mergeVerdict,
  reducePullRequestStates,
  rescuePlan,
} from "../scripts/sweep-worktrees.mjs";

const WORKTREE = "C:/work/coding/as-wt-example";

describe("looksLikeProcessList", () => {
  it("rejects an empty snapshot rather than reading it as 'nothing is running'", () => {
    // The HIGH this was written for. An empty string is a valid string, so a
    // `snapshot === null` check accepts it and every worktree then looks
    // unused — the permissive answer, produced exactly when we know least.
    expect(looksLikeProcessList("")).toBe(false);
    expect(looksLikeProcessList("   \n  \n ")).toBe(false);
  });

  it("rejects output that is not a process list", () => {
    expect(looksLikeProcessList("access denied")).toBe(false);
    expect(looksLikeProcessList("<html>error</html>")).toBe(false);
  });

  it("accepts a real listing", () => {
    // Self-verifying: the process taking the snapshot is itself node, so any
    // genuine listing names it. A snapshot that cannot see the process taking
    // it cannot see anything.
    expect(looksLikeProcessList("node.exe --version\nchrome.exe")).toBe(true);
  });
});

describe("hasLiveProcess", () => {
  it("sees a process whose command line carries the absolute path", () => {
    const snapshot = "node c:/work/coding/as-wt-example/node_modules/vitest.mjs";
    expect(hasLiveProcess(snapshot, WORKTREE)).toBe(true);
  });

  it("sees it through backslashes too", () => {
    const snapshot = "node c:\\work\\coding\\as-wt-example\\x.mjs";
    expect(hasLiveProcess(snapshot, WORKTREE)).toBe(true);
  });

  it("sees a run whose argv names the directory but not the full path", () => {
    // The second HIGH. `npx vitest run` from inside a worktree produces a
    // command line with no absolute path in it; before the basename match
    // this returned false and the worktree read as idle.
    expect(hasLiveProcess("node npx-cli.js vitest run --dir as-wt-example", WORKTREE)).toBe(true);
  });

  it("does not match an unrelated worktree", () => {
    // The guard must be able to return false, or it is not a guard — it is a
    // constant that happens to be safe.
    const snapshot = "node c:/work/coding/as-wt-something-else/x.mjs";
    expect(hasLiveProcess(snapshot, WORKTREE)).toBe(false);
  });

  it("does not treat an empty snapshot as proof of absence", () => {
    // Documents the boundary: hasLiveProcess alone cannot tell "nothing is
    // running" from "I was handed nothing", which is why the caller must
    // reject the snapshot via looksLikeProcessList before consulting this.
    expect(hasLiveProcess("", WORKTREE)).toBe(false);
    expect(looksLikeProcessList("")).toBe(false);
  });

  it("ignores a pathologically short basename instead of matching everything", () => {
    // A 3-character directory name would otherwise match almost any command
    // line and freeze the sweep into never removing anything.
    //
    // The snapshot must CONTAIN the short basename for this to test anything.
    // An earlier version paired "node server.mjs" with basename "abc", which
    // the snapshot does not contain either way — so the length floor was never
    // the deciding term and deleting it left this green. "abc" appears twice
    // below, in `abc.mjs` and inside `fabric`, exactly the incidental matches
    // the floor exists to reject.
    expect(hasLiveProcess("node abc.mjs --loader fabric", "C:/tmp/abc")).toBe(false);
  });
});

describe("reducePullRequestStates", () => {
  it("lets MERGED win over a later CLOSED on the same branch", () => {
    const states = reducePullRequestStates([
      { headRefName: "feat/x", state: "MERGED" },
      { headRefName: "feat/x", state: "CLOSED" },
    ]);
    expect(states.get("feat/x")).toBe("MERGED");
  });

  it("lets MERGED win regardless of the order it appears in", () => {
    const states = reducePullRequestStates([
      { headRefName: "feat/x", state: "CLOSED" },
      { headRefName: "feat/x", state: "MERGED" },
    ]);
    expect(states.get("feat/x")).toBe("MERGED");
  });

  it("does not invent merged-ness for a branch that only ever closed", () => {
    // A closed-unmerged PR is a person deciding not to take that work, so its
    // worktree may hold the only copy. Reporting it as MERGED would delete it.
    const states = reducePullRequestStates([{ headRefName: "feat/x", state: "CLOSED" }]);
    expect(states.get("feat/x")).toBe("CLOSED");
  });

  it("reports nothing for a branch GitHub has never seen", () => {
    const states = reducePullRequestStates([{ headRefName: "feat/x", state: "MERGED" }]);
    expect(states.get("feat/unknown")).toBeUndefined();
  });

  it("skips malformed entries rather than throwing", () => {
    const states = reducePullRequestStates([
      null,
      { state: "MERGED" },
      { headRefName: "feat/x", state: "MERGED" },
    ]);
    expect(states.size).toBe(1);
    expect(states.get("feat/x")).toBe("MERGED");
  });
});

describe("mergeVerdict", () => {
  // The merge decision is a pure function precisely so it can be tested here.
  // Logic that lives only inside `main()` is unreachable by any test, and the
  // defects that hide there are the ones about what the tool does when it
  // CANNOT know — which is exactly where deleting-things-wrongly lives.
  const base = "origin/main";
  const never = () => {
    throw new Error("countDiffering must not be consulted for this case");
  };

  it("accepts a branch whose pull request is merged", () => {
    const v = mergeVerdict({
      branch: "feat/x",
      prState: "MERGED",
      prsAvailable: true,
      base,
      countDiffering: never,
    });
    expect(v.removable).toBe(true);
  });

  it("refuses a CLOSED branch even when its content is identical to base", () => {
    // countDiffering would return 0 here. Refusing before consulting it is
    // the point: someone decided not to take that work.
    const v = mergeVerdict({
      branch: "feat/x",
      prState: "CLOSED",
      prsAvailable: true,
      base,
      countDiffering: () => 0,
    });
    expect(v.removable).toBe(false);
    expect(v.reason).toContain("CLOSED");
  });

  it("refuses a branch outright when the pull request state is unavailable", () => {
    // Falling through to the content check here is unsafe: a CLOSED branch
    // GitHub cannot be asked about would become REMOVABLE, so losing the PR
    // signal WIDENS deletion for that class even while the total falls. A net
    // count cannot detect that, which is why the invariant is asserted per
    // worktree in the next test rather than measured in aggregate.
    const v = mergeVerdict({
      branch: "feat/x",
      prState: undefined,
      prsAvailable: false,
      base,
      countDiffering: () => 0,
    });
    expect(v.removable).toBe(false);
    expect(v.reason).toContain("unavailable");
  });

  it("does not let losing gh turn a refusal into a removal", () => {
    // States the invariant directly: for one branch, holding tree state
    // constant, dropping the PR signal must never move removable false -> true.
    const withGh = mergeVerdict({
      branch: "feat/x",
      prState: "CLOSED",
      prsAvailable: true,
      base,
      countDiffering: () => 0,
    });
    const withoutGh = mergeVerdict({
      branch: "feat/x",
      prState: undefined,
      prsAvailable: false,
      base,
      countDiffering: () => 0,
    });
    expect(withGh.removable).toBe(false);
    expect(withoutGh.removable).toBe(false);
  });

  it("still uses the content check for a detached worktree when gh is unavailable", () => {
    // A detached worktree has no branch, so the PR record could never have
    // said anything about it; refusing it for a missing PR signal would strand
    // every reviewer checkout forever.
    const v = mergeVerdict({
      branch: null,
      prState: undefined,
      prsAvailable: false,
      base,
      countDiffering: () => 0,
    });
    expect(v.removable).toBe(true);
  });

  it("refuses when the branch still differs from base", () => {
    const v = mergeVerdict({
      branch: "feat/x",
      prState: undefined,
      prsAvailable: true,
      base,
      countDiffering: () => 3,
    });
    expect(v.removable).toBe(false);
    expect(v.reason).toContain("3 file(s) differ");
  });

  it("refuses when there is no merge-base to compare against", () => {
    const v = mergeVerdict({
      branch: "feat/x",
      prState: undefined,
      prsAvailable: true,
      base,
      countDiffering: () => null,
    });
    expect(v.removable).toBe(false);
    expect(v.reason).toContain("no merge-base");
  });

  it("accepts content present on base when gh is available and knows nothing", () => {
    const v = mergeVerdict({
      branch: "feat/x",
      prState: undefined,
      prsAvailable: true,
      base,
      countDiffering: () => 0,
    });
    expect(v.removable).toBe(true);
  });
});

describe("rescuePlan", () => {
  // The rescue-ref decision that fixes HIGH B, extracted as a pure function
  // for exactly the reason mergeVerdict already was: logic reachable only
  // from inside main() is logic no test can see. Mutating the original
  // inline guard (`if (containing.trim().length === 0)`) to `if (false)`
  // disabled rescue-ref minting entirely — restoring HIGH B's irreversible
  // deletion — while the 22-test suite stayed green, because nothing outside
  // main() could exercise it. These tests are the fix for that gap: each one
  // fails if the corresponding branch of rescuePlan is disabled or inverted.
  const HEAD = "abcdef0123456789";

  it("does nothing for a branched worktree", () => {
    const plan = rescuePlan({ branch: "feat/x", head: HEAD, containingRefs: "irrelevant" });
    expect(plan.action).toBe("none");
  });

  it("mints a rescue ref for a zero-ref detached commit", () => {
    // This is the exact case the `if (false)` mutant defeats: containingRefs
    // is empty, so no ref keeps this commit alive without minting one.
    const plan = rescuePlan({ branch: null, head: HEAD, containingRefs: "" });
    expect(plan.action).toBe("mint");
    expect(plan.ref).toBe(`refs/worktree-sweep/${HEAD.slice(0, 12)}`);
  });

  it("treats a whitespace-only containing-refs answer the same as empty", () => {
    const plan = rescuePlan({ branch: null, head: HEAD, containingRefs: "   \n  " });
    expect(plan.action).toBe("mint");
  });

  it("reuses an existing ref instead of minting when the commit is already contained", () => {
    const plan = rescuePlan({
      branch: null,
      head: HEAD,
      containingRefs: "refs/heads/main\nrefs/heads/other\n",
    });
    expect(plan.action).toBe("reuse");
    expect(plan.ref).toBe("refs/heads/main");
  });

  it("reports unknown rather than guessing when containment could not be determined", () => {
    // git(...) returns null on failure; the caller must refuse removal
    // rather than treat a failed lookup as "nothing contains it".
    const plan = rescuePlan({ branch: null, head: HEAD, containingRefs: null });
    expect(plan.action).toBe("unknown");
  });
});
