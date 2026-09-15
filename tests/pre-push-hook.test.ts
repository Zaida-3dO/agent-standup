// The pre-push hook as an actual process — `.githooks/pre-push`.
//
// It is a gate, so it ships a test that proves it fails on a seeded
// violation rather than only that it passes on clean input. It is also the
// one check here written in shell rather than TypeScript, which means
// nothing else in the repository would notice if it stopped working: no
// typecheck, no lint rule and no unit test reaches inside a `sh` script.
//
// Two defects motivate the cases below, and they pull in opposite
// directions, which is why both halves are pinned:
//
//   1. It ran content checks for a push carrying no content. A branch
//      deletion has nothing to format and nothing to lint, so a housekeeping
//      push was gated on a working tree with no bearing on it.
//   2. It reported "could not run" as "checks failed". With no
//      `node_modules`, prettier and eslint are simply absent, and the
//      message "fix the above" points at a code defect that does not exist.
//      A gate that cannot run must say so, not fail as though it had a
//      verdict.
//   3. The fix for (2) was keyed on npm exiting 127 and missed the case
//      that actually happens. **There are two different absences and only
//      one of them produces 127**: if `npm` itself is missing the *shell*
//      returns 127, but if npm is present and `node_modules` is not, npm
//      runs, `prettier` is what is missing, and npm reports that child's
//      failure as its own status — `1` on Windows, indistinguishable from a
//      real lint failure. Every crew works in a fresh worktree, so the
//      second is the common case, and it was blocked with exactly the
//      message the comment forbids. The suite was green throughout because
//      it only ever simulated the first.
//
// **How the tool-missing and failure cases are told apart without touching
// the real checks.** Each case runs the hook with a throwaway directory
// first on `PATH` containing a fake `npm`, so the hook's own
// `npm run format:check` resolves to a script this test controls. That makes
// exit code 127 (command not found), a genuine lint failure, and a clean
// pass all reproducible in a second, with no dependency on whether this
// checkout actually happens to be formatted.
//
// **Why some cases run a copy of the hook instead of the hook in place.**
// The hook decides could-not-run by looking for `node_modules/.bin`
// relative to its own location, and this checkout has its dependencies
// installed — so the absence cannot be staged here without deleting them.
// Those cases copy `.githooks/pre-push` into a temporary tree and run it
// there, where whether `node_modules` exists is the test's to decide. It is
// the same bytes either way: the file is copied, never rewritten.
//
// Skipped on a machine with no POSIX shell, which in practice means it runs
// everywhere this repository is developed — git ships one on Windows, which
// is what lets the hook itself be a single unbranched script.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const hookPath = path.join(repoRoot, ".githooks", "pre-push");

/** A zero sha of SHA-1 width — what git sends as the local sha of a deletion. */
const ZERO_SHA = "0".repeat(40);
const REAL_SHA = "aabbccddeeff00112233445566778899aabbccdd";

function haveShell(): boolean {
  try {
    execFileSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIfShell = haveShell() ? describe : describe.skip;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A directory holding a fake `npm` that behaves as `behaviour` says, meant to
 * be put first on `PATH`.
 *
 * `missing` writes a stub that exits 127 — the code a shell returns for a
 * command it cannot find — rather than writing nothing.
 *
 * Writing nothing does not work: merely prepending an empty directory leaves
 * the real `npm` further down `PATH` to be found anyway, and emptying `PATH`
 * outright makes `sh` itself unresolvable, so the hook never runs at all.
 * The stub reproduces the condition the hook actually keys on — a
 * `npm run ...` that comes back 127 — without having to dismantle the
 * environment around it.
 */
function fakeNpmDir(behaviour: "pass" | "fail" | "missing"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "prepush-"));
  tempDirs.push(dir);

  const exitCode = behaviour === "pass" ? 0 : behaviour === "fail" ? 1 : 127;
  const script = [
    "#!/bin/sh",
    behaviour === "missing" ? 'echo "sh: npm: command not found" >&2' : 'echo "fake npm: $*"',
    behaviour === "fail" ? 'echo "some/file.ts: needs formatting"' : "",
    `exit ${exitCode}`,
    "",
  ].join("\n");

  const npmPath = path.join(dir, "npm");
  writeFileSync(npmPath, script);
  chmodSync(npmPath, 0o755);
  return dir;
}

/** Runs the hook with `stdinLines` on stdin and a controlled `npm` first on PATH. */
function runHook(stdinLines: string[], behaviour: "pass" | "fail" | "missing") {
  const dir = fakeNpmDir(behaviour);
  // Windows spells the variable `Path`, and setting a second key that differs
  // only in case would leave the original in place and the fake unreachable.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  const result = spawnSync("sh", [hookPath], {
    cwd: repoRoot,
    input: stdinLines.map((line) => `${line}\n`).join(""),
    encoding: "utf8",
    env: {
      ...process.env,
      [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ""}`,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * A temporary checkout holding a copy of the real hook, where whether the
 * dependencies are installed is this test's to decide.
 *
 * `installed` writes the two launchers into `node_modules/.bin` exactly as
 * npm would. Their contents do not matter and are never executed — the hook
 * asks whether they are *there*, and the fake `npm` on `PATH` is what
 * actually answers for the checks. On Windows npm also writes a `.cmd`
 * shim beside each launcher; the hook accepts either, and these cases stage
 * the extensionless form so the same tree exercises both platforms' lookup.
 */
function hookTreeWithDeps(installed: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), "prepush-tree-"));
  tempDirs.push(dir);

  mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  copyFileSync(hookPath, path.join(dir, ".githooks", "pre-push"));

  if (installed) {
    const binDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    for (const tool of ["prettier", "eslint"]) writeFileSync(path.join(binDir, tool), "");
  }

  return dir;
}

/** Runs the copied hook inside `tree`, with a controlled `npm` first on PATH. */
function runHookIn(tree: string, stdinLines: string[], behaviour: "pass" | "fail" | "missing") {
  const dir = fakeNpmDir(behaviour);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  const result = spawnSync("sh", [path.join(tree, ".githooks", "pre-push")], {
    cwd: tree,
    input: stdinLines.map((line) => `${line}\n`).join(""),
    encoding: "utf8",
    env: {
      ...process.env,
      [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ""}`,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const CONTENT_PUSH = [`refs/heads/work ${REAL_SHA} refs/heads/work ${ZERO_SHA}`];

describeIfShell("the pre-push hook", () => {
  describe("a push that carries no content", () => {
    it("skips the checks entirely for a branch deletion", () => {
      // The all-zero local sha is how git signals a deletion. `missing`
      // proves the checks never ran: had they run, the 127 stub would have
      // produced the tool-missing message instead of this one.
      const { status, output } = runHook(
        [`(delete) ${ZERO_SHA} refs/heads/review/some-branch ${REAL_SHA}`],
        "missing",
      );

      expect(status).toBe(0);
      expect(output).toContain("nothing to check");
      expect(output).not.toContain("running format:check");
    });

    it("skips the checks when git sends nothing at all", () => {
      const { status, output } = runHook([], "missing");
      expect(status).toBe(0);
      expect(output).not.toContain("running format:check");
    });

    it("still runs the checks when a deletion is pushed alongside a real update", () => {
      // The boundary that stops "skip on any deletion" passing. This push
      // does carry content, so it must be checked.
      const { status, output } = runHook(
        [
          `(delete) ${ZERO_SHA} refs/heads/old ${REAL_SHA}`,
          `refs/heads/work ${REAL_SHA} refs/heads/work ${ZERO_SHA}`,
        ],
        "pass",
      );

      expect(output).toContain("running format:check");
      expect(status).toBe(0);
    });
  });

  describe("a push that carries content", () => {
    it("blocks when a check genuinely fails", () => {
      // The gate doing its job — and the case that must never be softened by
      // the tool-missing handling below.
      const { status, output } = runHook(
        [`refs/heads/work ${REAL_SHA} refs/heads/work ${ZERO_SHA}`],
        "fail",
      );

      expect(status).toBe(1);
      expect(output).toContain("blocked");
    });

    it("passes when the checks pass", () => {
      const { status } = runHook(
        [`refs/heads/work ${REAL_SHA} refs/heads/work ${ZERO_SHA}`],
        "pass",
      );
      expect(status).toBe(0);
    });

    it("says it could not run — not that checks failed — when the tools are absent", () => {
      // The second defect. With no npm on PATH the shell exits 127, and the
      // hook has to report that as "could not run" rather than pointing the
      // reader at a code defect that does not exist.
      const { status, output } = runHook(
        [`refs/heads/work ${REAL_SHA} refs/heads/work ${ZERO_SHA}`],
        "missing",
      );

      expect(output).toContain("DID NOT RUN");
      expect(output).not.toContain("blocked");
      // Deliberately not blocking: a checkout with no dependencies installed
      // is a housekeeping checkout, and CI runs the full list on every PR
      // regardless — so this costs a slower feedback loop, never a missed
      // check.
      expect(status).toBe(0);
    });
  });

  // The third defect: the case that actually happens to every crew, and the
  // one the suite above could not see. `npm` here is a working npm that
  // exits 0 — the deliberate opposite of the 127 stub — so nothing about
  // these cases can be satisfied by an exit code. What decides them is
  // whether `node_modules/.bin` holds the tools.
  describe("a checkout whose dependencies are not installed", () => {
    it("says the checks did not run — rather than blocking — when node_modules is absent", () => {
      // npm exits 0 here, never 127, so an exit-code test for absence
      // cannot fire and the checks would run against tools that are not
      // there. This is the fresh-worktree case, where a correct 15-line
      // docs push was reported as a lint failure.
      const { status, output } = runHookIn(hookTreeWithDeps(false), CONTENT_PUSH, "pass");

      expect(status).toBe(0);
      expect(output).toContain("DID NOT RUN");
      expect(output).toContain("prettier");
      expect(output).toContain("eslint");
      // It must not have got as far as running anything.
      expect(output).not.toContain("running format:check");
      expect(output).not.toContain("blocked");
    });

    it("distinguishes did-not-run from passed — it must not claim the checks were fine", () => {
      // The three-outcome discipline, pinned from the other side. A skip
      // that reads as a pass is the same defect as a skip that reads as a
      // failure: both collapse three states into two.
      const { output } = runHookIn(hookTreeWithDeps(false), CONTENT_PUSH, "pass");

      expect(output).toContain("not a pass and not a failure");
    });

    it("still blocks a genuine failure once the dependencies are installed", () => {
      // The boundary that stops "skip whenever anything looks off" passing.
      // Same fresh temp tree, same fake npm mechanism — the only difference
      // is that node_modules/.bin now holds the tools, so the checks are
      // allowed to run and their verdict is honoured.
      const { status, output } = runHookIn(hookTreeWithDeps(true), CONTENT_PUSH, "fail");

      expect(status).toBe(1);
      expect(output).toContain("running format:check");
      expect(output).toContain("blocked");
      expect(output).not.toContain("DID NOT RUN");
    });

    it("runs the checks normally when the dependencies are installed and clean", () => {
      const { status, output } = runHookIn(hookTreeWithDeps(true), CONTENT_PUSH, "pass");

      expect(status).toBe(0);
      expect(output).toContain("running format:check");
      expect(output).not.toContain("DID NOT RUN");
    });
  });
});
