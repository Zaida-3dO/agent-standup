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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findUnregisteredCheckouts,
  hasLiveProcess,
  looksLikeProcessList,
  mergeVerdict,
  normalisePath,
  reducePullRequestStates,
  rescuePlan,
  worktreeParents,
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

describe("worktreeParents", () => {
  // A registry can hold entries whose directories are absent. Their parents
  // are not places worktrees live, and counting them can stop the scan dead:
  // a rule requiring all worktrees to share one parent sees two — the real
  // directory and the absent one — and so scans nothing, which is exactly as
  // blind as having no scan at all.
  it("ignores registry entries whose directory is absent", () => {
    const live = mkdtempSync(join(tmpdir(), "wt-parents-"));
    const tree = join(live, "as-wt-live");
    mkdirSync(tree);
    try {
      const parents = worktreeParents([tree, join(live, "..", "gone-forever", "as-wt-old")]);
      // Only the extant tree's parent is evidence of where trees are kept.
      expect(parents.map(normalisePath)).toEqual([normalisePath(live)]);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });

  it("returns every distinct parent when extant worktrees are spread across two", () => {
    const a = mkdtempSync(join(tmpdir(), "wt-parents-a-"));
    const b = mkdtempSync(join(tmpdir(), "wt-parents-b-"));
    const ta = join(a, "as-wt-a");
    const tb = join(b, "as-wt-b");
    mkdirSync(ta);
    mkdirSync(tb);
    try {
      // Declining to scan, or picking one arbitrarily, loses the detection
      // outright; a superset only ever costs an extra reported line.
      const parents = worktreeParents([ta, tb]).map(normalisePath).sort();
      expect(parents).toEqual([normalisePath(a), normalisePath(b)].sort());
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("returns nothing when no registered worktree still exists", () => {
    const parents = worktreeParents([join(tmpdir(), "definitely-not-here-9c1f", "as-wt-x")]);
    expect(parents).toEqual([]);
  });
});

describe("findUnregisteredCheckouts", () => {
  // THE SEEDED VIOLATION. Everything else in this file is a pure-function
  // unit test that never touches a disk, and that is precisely how the gap
  // survived: the sweep enumerated only `git worktree list`, so a directory
  // git had no record of could not appear in its report at all, and no test
  // that never creates a directory can notice.
  //
  // So these build the real thing on a real filesystem — a directory holding
  // a checkout, which git was never told about — and assert the scan reports
  // it. A test that only ran the sweep over REGISTERED worktrees would prove
  // nothing whatsoever about this.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A directory that is a checkout, in the structural sense the scan uses. */
  function seedCheckout(name: string, gitAs: "dir" | "file" = "dir"): string {
    const dir = join(root, name);
    mkdirSync(dir);
    if (gitAs === "dir") mkdirSync(join(dir, ".git"));
    else writeFileSync(join(dir, ".git"), "gitdir: /somewhere/else\n");
    return dir;
  }

  it("reports a checkout git has no record of", () => {
    const orphan = seedCheckout("as-wt-orphan");
    const found = findUnregisteredCheckouts(root, []);
    // Assert on the whole array rather than through `?.`: an optional chain
    // makes a null result (which means "could not look") pass a test written
    // to prove the orphan was FOUND.
    expect(found).toEqual([{ path: orphan, state: "checkout" }]);
  });

  it("reports a linked worktree whose .git is a FILE, not a directory", () => {
    // The shape that actually accumulates here: every `git worktree add`
    // tree carries a `.git` FILE holding a gitdir pointer. A scan that only
    // accepted a `.git` directory would miss every orphaned worktree and
    // catch only hand-made clones — i.e. it would miss the common case.
    const orphan = seedCheckout("as-wt-detached", "file");
    const found = findUnregisteredCheckouts(root, []);
    expect(found?.map((f) => f.path)).toEqual([orphan]);
  });

  it("reports a checkout reached through a directory symlink", () => {
    // Mutation-driven: dropping `|| entry.isSymbolicLink()` left the suite
    // green. On Windows a junction or symlink to a directory reports
    // isDirectory() === false, so classifying by the link rather than by
    // what it resolves to makes an entire class of checkout invisible —
    // the same blind spot as the registry gap, wearing a different hat.
    const real = mkdtempSync(join(tmpdir(), "wt-scan-target-"));
    mkdirSync(join(real, ".git"));
    const link = join(root, "as-wt-linked");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      // Symlink creation can require privileges; skip rather than fail.
      rmSync(real, { recursive: true, force: true });
      return;
    }
    try {
      const found = findUnregisteredCheckouts(root, []);
      expect(found?.map((f) => f.path)).toEqual([link]);
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("does not report a checkout git already knows about", () => {
    const known = seedCheckout("as-wt-known");
    expect(findUnregisteredCheckouts(root, [known])).toEqual([]);
  });

  it("matches the registry through case and slash differences", () => {
    // Windows reaches one directory by several spellings. Comparing them
    // literally would report an ordinary registered worktree as
    // unregistered, and a report that cries wolf is one nobody reads.
    const known = seedCheckout("as-wt-Case");
    const spelled = known.replace(/\\/g, "/").toUpperCase();
    expect(findUnregisteredCheckouts(root, [spelled])).toEqual([]);
  });

  it("ignores a plain directory that is not a checkout", () => {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "loose.txt"), "x");
    expect(findUnregisteredCheckouts(root, [])).toEqual([]);
  });

  it("finds an orphan sitting alongside registered worktrees", () => {
    // The real configuration: the orphan is not alone, it is the one extra
    // directory among several legitimate ones — which is exactly why nobody
    // spots it by eye.
    const known = seedCheckout("as-wt-known");
    const alsoKnown = seedCheckout("as-wt-known-2");
    const orphan = seedCheckout("as-wt-orphan");
    const found = findUnregisteredCheckouts(root, [known, alsoKnown]);
    expect(found?.map((f) => f.path)).toEqual([orphan]);
  });

  it("reports a directory it cannot classify, instead of skipping it", () => {
    // Mutation-driven. Deleting the `unreadable` report left the whole suite
    // green, because with the real classifier this branch is unreachable —
    // `existsSync` returns false for an unreadable path rather than throwing.
    // A guard no test can reach is not a guard, so the classifier is injected
    // and made to fail here on purpose.
    //
    // Skipping would be the seductive wrong answer: it produces a clean,
    // confident report that quietly omits the one directory nobody could
    // read — which is precisely the directory a human should look at.
    seedCheckout("as-wt-fine");
    const cursed = join(root, "as-wt-cursed");
    mkdirSync(cursed);
    const found = findUnregisteredCheckouts(root, [], (dir: string) => {
      if (dir === cursed) throw new Error("EPERM");
      return true;
    });
    expect(found).toEqual([
      { path: join(root, "as-wt-cursed"), state: "unreadable" },
      { path: join(root, "as-wt-fine"), state: "checkout" },
    ]);
  });

  it("reports that it could not look, rather than an empty list", () => {
    // An unreadable directory and an empty one must not be the same answer.
    // "No unregistered directories" when the truth is "could not look" is
    // the same permissive-on-ignorance defect `looksLikeProcessList` exists
    // to prevent one layer out.
    expect(findUnregisteredCheckouts(join(root, "no-such-dir"), [])).toBeNull();
  });
});
