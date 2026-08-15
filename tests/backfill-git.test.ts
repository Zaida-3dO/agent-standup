// `src/lib/backfill/git.ts` — reading a real repository's default branch
// for a converter, rather than a converter defaulting to a guess
// (MILESTONES.md #124).
//
// Pure unit tests: the command runner is injected, so no real git binary or
// checkout is needed and every failure mode (no remote, unresolved
// origin/HEAD, garbage output) is reachable deterministically.
import { describe, expect, it } from "vitest";
import {
  DefaultBranchUndeterminedError,
  readDefaultBranch,
  readDefaultBranches,
  type CommandRunner,
} from "@/lib/backfill/git";

/** Builds a runner that returns a fixed stdout for `git symbolic-ref …`, or throws. */
function fakeRunner(
  behavior: (repoPath: string) => { stdout: string } | { throws: unknown },
): CommandRunner {
  return async (command, args, options) => {
    expect(command).toBe("git");
    expect(args).toEqual(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const result = behavior(options.cwd);
    if ("throws" in result) throw result.throws;
    return result;
  };
}

describe("readDefaultBranch", () => {
  it("reads the real branch from `git symbolic-ref refs/remotes/origin/HEAD`", async () => {
    const runner = fakeRunner(() => ({ stdout: "refs/remotes/origin/main\n" }));
    await expect(readDefaultBranch("/repos/web", runner)).resolves.toBe("main");
  });

  it("reads a NON-master/main branch faithfully — no normalisation onto a common name", async () => {
    // The exact defect this closes: an importer that silently assumed one
    // spelling would turn this into "main" or "master". Asserting the
    // uncommon value is what a hardcoded fallback would fail.
    const runner = fakeRunner(() => ({ stdout: "refs/remotes/origin/trunk\n" }));
    await expect(readDefaultBranch("/repos/infra", runner)).resolves.toBe("trunk");
  });

  it("REJECTS with DefaultBranchUndeterminedError when git fails — never substitutes a fallback string", async () => {
    const gitError = new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");
    const runner = fakeRunner(() => ({ throws: gitError }));
    await expect(readDefaultBranch("/repos/no-remote", runner)).rejects.toBeInstanceOf(
      DefaultBranchUndeterminedError,
    );
  });

  it("names the repo path and the underlying git error in the rejection", async () => {
    const gitError = new Error("fatal: not a git repository");
    const runner = fakeRunner(() => ({ throws: gitError }));
    await expect(readDefaultBranch("/repos/not-a-checkout", runner)).rejects.toThrow(
      /not-a-checkout.*not a git repository/s,
    );
  });

  it("REJECTS on output that isn't a resolvable refs/remotes/origin/* ref, rather than guessing", async () => {
    const runner = fakeRunner(() => ({ stdout: "not-a-ref-at-all\n" }));
    await expect(readDefaultBranch("/repos/weird", runner)).rejects.toBeInstanceOf(
      DefaultBranchUndeterminedError,
    );
  });

  it("REJECTS empty output rather than returning an empty string as a branch name", async () => {
    const runner = fakeRunner(() => ({ stdout: "" }));
    await expect(readDefaultBranch("/repos/empty", runner)).rejects.toBeInstanceOf(
      DefaultBranchUndeterminedError,
    );
  });
});

describe("readDefaultBranches", () => {
  it("resolves every repo it can and reports the rest as undetermined, rather than aborting the batch", async () => {
    const runner: CommandRunner = async (_command, _args, options) => {
      if (options.cwd === "/repos/web") return { stdout: "refs/remotes/origin/main\n" };
      if (options.cwd === "/repos/infra") return { stdout: "refs/remotes/origin/trunk\n" };
      throw new Error("fatal: no such remote");
    };

    const result = await readDefaultBranches(
      [
        { label: "web-app", path: "/repos/web" },
        { label: "infra-tools", path: "/repos/infra" },
        { label: "legacy", path: "/repos/legacy" },
      ],
      runner,
    );

    expect(result.resolved).toEqual({ "web-app": "main", "infra-tools": "trunk" });
    expect(result.undetermined).toEqual(["legacy"]);
  });

  it("returns an entirely empty resolved map, not a fabricated one, when nothing can be determined", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("fatal: no such remote");
    };

    const result = await readDefaultBranches([{ label: "orphan", path: "/repos/orphan" }], runner);
    expect(result.resolved).toEqual({});
    expect(result.undetermined).toEqual(["orphan"]);
  });

  it("keeps reading the rest of the batch after one repo's runner throws", async () => {
    // One unreadable checkout must not abort a batch reading many others —
    // that would make a single stale or missing local clone block every
    // other repository's real branch from ever being recorded.
    const runner: CommandRunner = async (_command, _args, options) => {
      if (options.cwd === "/repos/first") throw new Error("fatal: no such remote");
      return { stdout: "refs/remotes/origin/main\n" };
    };

    const result = await readDefaultBranches(
      [
        { label: "first", path: "/repos/first" },
        { label: "second", path: "/repos/second" },
      ],
      runner,
    );

    expect(result.undetermined).toEqual(["first"]);
    expect(result.resolved).toEqual({ second: "main" });
  });
});
