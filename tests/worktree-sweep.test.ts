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
  reducePullRequestStates,
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
    expect(hasLiveProcess("node server.mjs", "C:/tmp/abc")).toBe(false);
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
