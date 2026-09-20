// The build stamp: **a built hook artifact can say which source it came from.**
//
// ── The failure this covers ─────────────────────────────────────────────
//
// A vendored `standup-hook.http.mjs` ran on every tool call of every session
// for eight days carrying a build made *before* the capture loop it was meant
// to exercise (`654aeb2`, PR #317). It contained zero occurrences of
// `capture`. It exited 0 every time and recorded nothing, and a board row
// waited on evidence it could never produce while reading as healthy.
//
// Nothing in that artifact said which build it was. The only way to find out
// was to grep the bundle for a symbol you already suspected was missing —
// which needs the answer before you can ask the question.
//
// ── What a green run here means, and what it does not ──────────────────
//
// It means the stamping *mechanism* is wired: the bundler resolves a commit,
// esbuild substitutes it, the entry point reads it from the shared module
// rather than repeating it, and a built artifact prints it back. It does
// **not** mean any particular vendored copy on any particular machine is
// fresh — nothing here can know that, because the stale artifact lived in a
// different repository. That is `scripts/check-hook-freshness.mjs`'s job, and
// `tests/check-hook-freshness.test.ts` covers the decision it makes.
//
// The split matters: this file proves the artifact can *answer*, the other
// proves the answer is *judged correctly*. Neither is useful without the
// other, and a green tick here should not be read as "the deployment is
// current" — reading a check as stronger than it is being the exact family of
// mistake this whole row exists to stop.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_BUILD_COMMIT, UNSTAMPED, formatBuildStamp, isStamped } from "@/lib/hook/build-stamp";
import {
  BUILD_COMMIT_ENV,
  HOOK_SCRIPTS_DIR,
  HOOK_SCRIPT_ENTRY_POINTS,
  REQUIRE_STAMP_ENV,
  UNSTAMPED as BUILDER_UNSTAMPED,
  UnstampedBuildError,
  resolveBuildCommit,
} from "../scripts/build-hook-scripts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * `resolveBuildCommit` as run from outside any git checkout.
 *
 * A child process with its `cwd` at the filesystem root, because `cwd` is
 * what decides whether git finds a repository and this test process is
 * inside one. `pathToFileURL`, not a bare path: on Windows the default ESM
 * loader rejects `C:/...` as an unsupported URL scheme, so a bare path fails
 * for a reason that has nothing to do with git.
 *
 * With `expectFailure`, returns the exit status and the combined output
 * instead of throwing — the failing case is the behaviour under test, not an
 * accident.
 */
function resolveOutsideCheckout(env: Record<string, string>): string;
function resolveOutsideCheckout(
  env: Record<string, string>,
  options: { expectFailure: true },
): { status: number | null; output: string };
function resolveOutsideCheckout(
  env: Record<string, string>,
  options?: { expectFailure: true },
): string | { status: number | null; output: string } {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts", "build-hook-scripts.mjs")).href;
  const source = `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(m.resolveBuildCommit()));`;
  const result = spawnSync(process.execPath, ["-e", source], {
    // A directory with no `.git` anywhere above it. The system temp root is
    // not inside any checkout on any machine this runs on.
    cwd: path.parse(process.cwd()).root,
    encoding: "utf-8",
    // The child must not inherit this process's own values for these — the
    // suite could otherwise be run under a shell that happens to set them.
    //
    // Cast because Next's ambient types narrow `ProcessEnv` to require
    // `NODE_ENV`, while the whole point here is to hand the child an
    // environment this test controls. The spread of `process.env` carries
    // `NODE_ENV` through in practice; the cast only stops the type system
    // insisting it be restated.
    env: { ...cleanEnv(), ...env } as NodeJS.ProcessEnv,
  });

  if (options?.expectFailure) {
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
  if (result.status !== 0) {
    throw new Error(`expected a clean resolve, got ${result.status}: ${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

/** This process's environment with the stamp variables removed. */
function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  delete copy[BUILD_COMMIT_ENV];
  delete copy[REQUIRE_STAMP_ENV];
  return copy;
}

describe("the stamp's sentinel", () => {
  it("is the same string in the bundler and in the module it substitutes into", () => {
    // The two live in deliberately separate files — one drives esbuild, one
    // is bundled *by* esbuild — so the value is necessarily written twice.
    // This is what stops the two drifting: if the bundler emitted "unknown"
    // while the module tested for "unstamped", every unstamped build would
    // read as a real commit named "unknown" and the checker would call it
    // `unknown-commit` instead of `unstamped`. Both are non-zero exits, so
    // nothing would visibly break — it would just report the wrong reason
    // forever.
    expect(BUILDER_UNSTAMPED).toBe(UNSTAMPED);
  });

  it("is not mistaken for a commit", () => {
    expect(isStamped(UNSTAMPED)).toBe(false);
    expect(formatBuildStamp(UNSTAMPED)).toBe(UNSTAMPED);
  });

  it("treats an empty or blank stamp as naming nothing", () => {
    // A bundler that substituted an empty string would otherwise produce an
    // artifact claiming a commit whose name is "", which `isStamped` must
    // not dignify as provenance.
    expect(isStamped("")).toBe(false);
    expect(isStamped("   ")).toBe(false);
    expect(formatBuildStamp("")).toBe(UNSTAMPED);
  });

  it("accepts a real commit sha as naming a build", () => {
    const sha = "e67b0184368ecd7b0af210aba42e30c01a29e64c";
    expect(isStamped(sha)).toBe(true);
    expect(formatBuildStamp(sha)).toBe(sha);
    // The dirty form still names its commit — that is the point of keeping
    // the sha rather than reducing the whole stamp to a bare marker.
    expect(isStamped(`${sha}-dirty`)).toBe(true);
    expect(formatBuildStamp(`${sha}-dirty`)).toBe(`${sha}-dirty`);
  });
});

describe("the constant, read outside a build", () => {
  it("is the sentinel, because vitest does not run esbuild's define", () => {
    // Documents the deliberate behaviour rather than asserting an accident:
    // an unbundled consumer reads this module as ordinary source, so the
    // `typeof` guard in `build-stamp.ts` must yield the sentinel instead of
    // throwing a ReferenceError on an identifier that genuinely is not there.
    expect(HOOK_BUILD_COMMIT).toBe(UNSTAMPED);
  });
});

describe("how the bundler resolves a commit", () => {
  it("names this checkout's HEAD when run inside it", () => {
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    // May or may not carry `-dirty` depending on the working tree, so the
    // assertion is on the commit half — the suffix is covered below against
    // a checkout whose state this test controls.
    expect(resolveBuildCommit()).toMatch(new RegExp(`^${head}(-dirty)?$`));
  });

  it("marks a build from a modified tree -dirty, and a clean one not", () => {
    // **The assertion that catches the most dangerous single-line edit here.**
    // Dropping the `-dirty` suffix — `return commit` instead of the
    // conditional — leaves a build from a modified tree claiming the bare
    // commit it started from. The checker would then compare it equal to a
    // clean build of that commit and call it fresh, so an artifact containing
    // uncommitted edits nobody can reproduce would pass as current. That is
    // this row's bug wearing a different hat, and it is invisible to any
    // assertion that treats the suffix as optional.
    //
    // Both states are pinned against a scratch repository this test owns, so
    // the result does not depend on whether the developer's tree happens to
    // be clean when they run it.
    const scratch = mkdtempSync(path.join(tmpdir(), "build-stamp-dirty-"));
    tempDirs.push(scratch);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", scratch, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    // On a HOOK SOURCE PATH, because the stamp is scoped to those paths —
    // a scratch repository whose only file is `a.txt` has no hook history
    // for the stamp to name, and correctly answers UNSTAMPED. The file has
    // to be one esbuild would actually bundle for the question to apply.
    mkdirSync(path.join(scratch, "src", "lib", "hook"), { recursive: true });
    const hookFile = path.join("src", "lib", "hook", "a.ts");
    writeFileSync(path.join(scratch, hookFile), "one\n", "utf-8");
    git("add", hookFile);
    git("commit", "-qm", "first");
    const head = git("rev-parse", "HEAD").trim();

    /** `resolveBuildCommit` as run with `scratch` as the working directory. */
    const resolveIn = () =>
      execFileSync(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(
            pathToFileURL(path.join(repoRoot, "scripts", "build-hook-scripts.mjs")).href,
          )}).then((m) => process.stdout.write(m.resolveBuildCommit()));`,
        ],
        { cwd: scratch, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();

    // Clean: the bare commit, with no suffix at all.
    expect(resolveIn()).toBe(head);

    // Modified: the same commit, marked. Asserted as the exact string rather
    // than a regex allowing an optional suffix — an optional match is what
    // let this mutation survive in the first place.
    writeFileSync(path.join(scratch, hookFile), "two\n", "utf-8");
    expect(resolveIn()).toBe(`${head}-dirty`);

    // An untracked file counts too: it can be bundled, so a build made with
    // one present is no more reproducible than one with a modified file.
    writeFileSync(path.join(scratch, hookFile), "one\n", "utf-8");
    expect(resolveIn()).toBe(head);
    writeFileSync(path.join(scratch, "src", "lib", "hook", "untracked.ts"), "new\n", "utf-8");
    expect(resolveIn()).toBe(`${head}-dirty`);
  });

  // ── The stamp names the HOOK's last commit, not HEAD ──────────────────
  //
  // Stamping HEAD answers "which server build emitted this" rather than
  // "which hook code is this", and the two diverge on every commit that does
  // not touch the hook — which is most commits. Measured consequence: two
  // 60,819-byte artifacts differing on exactly one line, the stamp itself,
  // reported as drifted. A session then inferred a bug from a stamp that had
  // moved while `toWireBatch` was byte-identical across the window.
  //
  // Mutation that breaks it: restoring `["rev-parse", "HEAD"]` in
  // `resolveBuildCommitFromGit`, which makes the second assertion return the
  // unrelated commit.
  it("does not move for a commit that cannot have changed the bundle", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "build-stamp-stable-"));
    tempDirs.push(scratch);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", scratch, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    mkdirSync(path.join(scratch, "src", "lib", "hook"), { recursive: true });
    const hookFile = path.join("src", "lib", "hook", "a.ts");
    writeFileSync(path.join(scratch, hookFile), "one\n", "utf-8");
    git("add", hookFile);
    git("commit", "-qm", "touches the hook");
    const hookCommit = git("rev-parse", "HEAD").trim();

    const resolveIn = () =>
      execFileSync(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(
            pathToFileURL(path.join(repoRoot, "scripts", "build-hook-scripts.mjs")).href,
          )}).then((m) => process.stdout.write(m.resolveBuildCommit()));`,
        ],
        { cwd: scratch, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();

    expect(resolveIn()).toBe(hookCommit);

    // A README commit: HEAD moves, the bundle cannot have changed, so the
    // stamp must not move. This is the whole defect in one assertion.
    writeFileSync(path.join(scratch, "README.md"), "docs\n", "utf-8");
    git("add", "README.md");
    git("commit", "-qm", "touches nothing in the hook");
    expect(git("rev-parse", "HEAD").trim()).not.toBe(hookCommit);
    expect(resolveIn()).toBe(hookCommit);

    // And it still moves when the hook genuinely changes, which is the
    // property a stamp that never moved would also satisfy.
    writeFileSync(path.join(scratch, hookFile), "two\n", "utf-8");
    git("add", hookFile);
    git("commit", "-qm", "changes the hook");
    expect(resolveIn()).toBe(git("rev-parse", "HEAD").trim());
  });

  it("reports UNSTAMPED rather than throwing when there is no git checkout", () => {
    // Building from an unpacked tarball or a container that copied sources
    // without `.git` is legitimate and must not fail the build. The honest
    // answer there is "provenance unknown", which the checker then treats as
    // unverifiable rather than as current.
    // `pathToFileURL`, not a bare path: on Windows the default ESM loader
    // rejects `C:/...` as an unsupported URL scheme, so a bare path here
    // fails for a reason that has nothing to do with git.
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts", "build-hook-scripts.mjs")).href;
    const outside = execFileSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(m.resolveBuildCommit()));`,
      ],
      {
        // A directory with no `.git` anywhere above it. The system temp root
        // is not inside any checkout on any machine this runs on.
        cwd: path.parse(process.cwd()).root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    expect(outside).toBe(UNSTAMPED);
  });
});

describe("a commit handed to the build rather than found by it", () => {
  // **This is the block that covers the shipped defect.**
  //
  // The Docker build copies `package.json`, `prisma` and `scripts` — not the
  // repository — so `git rev-parse HEAD` threw there on every single build and
  // the script fell back to the sentinel. esbuild's `define` then compiled
  // `"unstamped"` into the bundle as a literal, which is why the served
  // artifact read `BUILD_COMMIT = true ? "unstamped" : UNSTAMPED` and why two
  // separate redeploys changed nothing: no deploy can fix a constant baked
  // into the artifact it is deploying.
  //
  // `resolveBuildCommit` takes its environment as an argument for the reason
  // `readBuildInfo` does — a function that reads `process.env` directly can
  // only be tested against whatever the process happened to start with, which
  // is exactly the kind of test that stays green while the plumbing is broken.

  const sha = "e67b0184368ecd7b0af210aba42e30c01a29e64c";

  it("stamps the commit it was given, without consulting git", () => {
    // Mutation that breaks it: deleting the `COMMIT_SHAPE.test(supplied)`
    // early return, so the function always falls through to `git`. That is
    // the pre-fix behaviour, and inside the container it resolves to the
    // sentinel every time.
    //
    // The assertion is `toBe(sha)` and not "is a sha": this test runs inside a
    // checkout, so a resolver that ignored the supplied value entirely would
    // still return *some* valid sha — this checkout's HEAD — and pass a shape
    // assertion while doing precisely the wrong thing.
    expect(resolveBuildCommit({ [BUILD_COMMIT_ENV]: sha })).toBe(sha);
  });

  it("preserves a -dirty suffix on a commit it was given", () => {
    // The supplied value is a *bundler* input, not an OCI label, so it can
    // legitimately carry the suffix. A validator written as a bare 40-hex
    // match would reject this and silently fall back to git.
    expect(resolveBuildCommit({ [BUILD_COMMIT_ENV]: `${sha}-dirty` })).toBe(`${sha}-dirty`);
  });

  it("ignores a supplied value that is not a commit, rather than stamping it", () => {
    // **The most valuable assertion here.** Docker turns an `ARG` nobody
    // passed into an *empty* environment variable, not an unset one, so an
    // empty string is the normal shape of a misconfigured pipeline. A
    // resolver that trusted the variable whenever it was a string would bake
    // a stamp of `""` into the bundle — and `isStamped("")` is false, so the
    // artifact would report `unstamped` while the build looked like it had
    // worked. That is this row's original defect, restored by way of its own
    // fix, and it is invisible to any test that only supplies valid input.
    //
    // Mutation that breaks it: weakening the shape test to a mere
    // presence test — `if (supplied !== "")`, or
    // `if (typeof raw === "string")`.
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const shape = new RegExp(`^${head}(-dirty)?$`);

    for (const junk of [
      "",
      "   ",
      "unstamped",
      "not-a-sha",
      "HEAD",
      sha.slice(0, 7),
      `${sha}xyz`,
    ]) {
      // Falls through to git, which inside this checkout names HEAD — so the
      // junk is demonstrably not what got stamped.
      expect(resolveBuildCommit({ [BUILD_COMMIT_ENV]: junk })).toMatch(shape);
    }
  });

  it("still reads git when nothing was handed to it", () => {
    // The regression guard for every build that is not the container one:
    // adding an env lookup must not have displaced the ordinary path.
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    expect(resolveBuildCommit({})).toMatch(new RegExp(`^${head}(-dirty)?$`));
  });
});

describe("what a build does when it cannot name its commit", () => {
  // Acceptance criterion 3, decided: an unstamped build fails loudly **when
  // it is a release build**, and stays quiet otherwise.
  //
  // Both halves are load-bearing, and a test for only one of them would let
  // the wrong design through. Failing unconditionally would break building
  // from an unpacked tarball — legitimate, and genuinely unable to name a
  // commit — to gain nothing. Never failing is what shipped: the build step
  // succeeded, the image published, and the artifact silently disabled every
  // freshness check downstream of it.
  //
  // The distinguishing fact is not observable from inside the script, so the
  // caller declares it. The Dockerfile sets the variable because an image is
  // always a release artifact; a bare `node scripts/build-hook-scripts.mjs`
  // does not.

  /** An environment with no supplied commit, so the git fallback decides. */
  const noCommit = (extra: Record<string, string> = {}) => ({ ...extra });

  it("is silent about an unstamped build that never claimed to be a release", () => {
    // Runs outside any checkout, in a child process, for the same reason the
    // existing no-git test does: `cwd` is what decides whether git finds a
    // repository, and this process is inside one.
    expect(resolveOutsideCheckout({})).toBe(UNSTAMPED);
  });

  it("fails the build when a release build cannot name its commit", () => {
    // Mutation that breaks it: dropping the `isEnabled(env[REQUIRE_STAMP_ENV])`
    // branch so the function always returns the sentinel — i.e. reverting to
    // exactly the behaviour that shipped an unstamped bundle through every
    // release and survived two redeploys.
    const result = resolveOutsideCheckout({ [REQUIRE_STAMP_ENV]: "1" }, { expectFailure: true });
    expect(result.status).not.toBe(0);
    // The message has to name the remedy, not merely complain. A loud failure
    // whose text does not say what to set is one people learn to scroll past.
    expect(result.output).toContain(BUILD_COMMIT_ENV);
    expect(result.output).toContain("APP_REVISION");
    // And it must not be a raw stack dump — the CLI wrapper prints an
    // `UnstampedBuildError`'s message alone on purpose.
    expect(result.output).not.toContain("at resolveBuildCommit");
  });

  it("does not fail a release build that was given a valid commit", () => {
    // The other side of the gate: the strictness must be satisfiable, or the
    // Docker build could never succeed. This is the case that actually runs
    // in the image.
    expect(
      resolveOutsideCheckout({
        [REQUIRE_STAMP_ENV]: "1",
        [BUILD_COMMIT_ENV]: "e67b0184368ecd7b0af210aba42e30c01a29e64c",
      }),
    ).toBe("e67b0184368ecd7b0af210aba42e30c01a29e64c");
  });

  it("reads Docker's empty-ARG shape as 'not a release build', not as 'yes'", () => {
    // An `ARG` with no default that nobody supplies becomes an empty string
    // in the image rather than being unset. A presence check (`!== undefined`)
    // would therefore read *every* build as a release build and start failing
    // tarball builds — the breakage the opt-in design exists to avoid.
    for (const off of ["", "  ", "0", "false", "FALSE"]) {
      expect(resolveOutsideCheckout(noCommit({ [REQUIRE_STAMP_ENV]: off }))).toBe(UNSTAMPED);
    }
  });

  it("exports the error type it throws, so a caller can tell it apart", () => {
    // Structural: the CLI wrapper narrows on this class to decide whether to
    // print a message or a stack. An edit that threw a bare `Error` would
    // make every unstamped release failure print a stack trace instead of the
    // remedy, which passes every behavioural assertion above except the
    // "not a stack dump" one.
    expect(typeof UnstampedBuildError).toBe("function");
    expect(new UnstampedBuildError("x")).toBeInstanceOf(Error);
    expect(new UnstampedBuildError("x").name).toBe("UnstampedBuildError");
  });
});

describe("the Dockerfile's half of the plumbing", () => {
  // The script being *able* to accept a commit is worth nothing if the image
  // build never hands it one — and that half cannot be proved by calling the
  // function, because it lives in the Dockerfile's stage topology.
  //
  // This is the assertion that would have caught the shipped defect at review
  // time. `ARG APP_REVISION` was declared, correctly and with a good comment,
  // in the `runner` stage only; `RUN node scripts/build-hook-scripts.mjs`
  // runs in the earlier `build` stage, where that ARG is not in scope. Docker
  // ARGs are per-stage, so the value reached the runtime environment (where
  // `build-info.ts` reads it) and never reached the bundler at all. Every
  // behavioural test in this file passed throughout.
  //
  // Textual rather than a real `docker build`: Docker is not available on
  // every machine this suite runs on, and a test that silently skips is how
  // the freshness check ended up inert in CI. See
  // `tests/check-hook-freshness.test.ts` for the same reasoning.
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");

  /** The `build` stage's text, from its `FROM` to the next one. */
  const buildStage = (() => {
    const stages = dockerfile.split(/^FROM /m);
    const stage = stages.find((s) => s.startsWith("node:24-alpine AS build\n"));
    if (stage === undefined) throw new Error("no `build` stage in the Dockerfile");
    return stage;
  })();

  it("declares APP_REVISION in the stage that builds the hook scripts", () => {
    // Mutation that breaks it: deleting the `ARG APP_REVISION` line from the
    // build stage — which is the state this row was filed against.
    expect(buildStage).toMatch(/^ARG APP_REVISION=/m);
  });

  /**
   * The single `RUN` command that builds the hook scripts, with its shell
   * line-continuations folded into one line.
   *
   * Extracted rather than asserted against the whole stage with a
   * `[\s\S]*?` bridge, because that is a hollow assertion and was caught
   * being one: a lazy gap still spans arbitrarily far, so a regex looking
   * for the variable *somewhere before* the command matched text from a
   * different `RUN` — and deleting the variable from the command under test
   * left the suite green. The assertion has to be scoped to the command that
   * actually carries the variable into the process.
   */
  const hookBuildCommand = (() => {
    const folded = buildStage.replace(/\\\r?\n\s*/g, " ");
    const command = folded
      .split(/\r?\n/)
      .find((line) => line.startsWith("RUN ") && line.includes("build-hook-scripts.mjs"));
    if (command === undefined) {
      throw new Error("no RUN builds the hook scripts in the `build` stage");
    }
    return command;
  })();

  it("hands that value to the bundler on the command that runs it", () => {
    // Not merely "the ARG is in scope": it has to actually be passed, on this
    // command. An ARG declared and never referenced is indistinguishable at
    // runtime from one that was never declared.
    //
    // Mutation that breaks it: dropping `STANDUP_HOOK_BUILD_COMMIT=...` from
    // the RUN while leaving the ARG above it in place.
    expect(hookBuildCommand).toContain('STANDUP_HOOK_BUILD_COMMIT="$APP_REVISION"');
  });

  it("can be told to fail rather than ship an unstamped bundle", () => {
    // Criterion 3 as it applies to the artifact that actually matters.
    //
    // Wired from an ARG rather than hardcoded to `1`, because not every
    // build of this Dockerfile is a release: CI builds it as a dry run with
    // no build arguments, and that build has no commit to be missing. The
    // release workflow is the one caller that knows it is cutting a release,
    // so it is the one that turns this on — asserted in
    // `tests/build-version-plumbing.test.ts`.
    //
    // Mutation that breaks it: deleting the
    // `STANDUP_HOOK_REQUIRE_BUILD_STAMP` assignment from the RUN. That
    // mutation survived the first version of this test, which is why it is
    // asserted against the command rather than the whole stage.
    expect(hookBuildCommand).toContain('STANDUP_HOOK_REQUIRE_BUILD_STAMP="$REQUIRE_BUILD_STAMP"');
    expect(buildStage).toMatch(/^ARG REQUIRE_BUILD_STAMP=/m);
  });

  it("does not copy the git repository in to make git work", () => {
    // The fix that was explicitly ruled out, asserted so nobody reaches for
    // it later: shipping the whole history into a production image to recover
    // one string the pipeline already holds.
    expect(dockerfile).not.toMatch(/^COPY\s+\.git\b/m);
  });
});

describe("how the entry point declares its build", () => {
  const entryPoint = readFileSync(path.join(repoRoot, "src", "bin", "standup-hook.ts"), "utf-8");

  it("reads the shared constant rather than carrying its own", () => {
    // The structural assertion, in the manner of
    // `tests/hook-protocol-version.test.ts`. The behavioural tests below
    // pass whether the entry point reads the module or hard-codes a string
    // that happens to look right; this one is what makes the *mechanism* the
    // thing asserted, so an edit that swaps the read for a literal fails here
    // rather than silently shipping an artifact that lies about its commit.
    expect(entryPoint).toContain('from "@/lib/hook/build-stamp"');
    expect(entryPoint).toContain("HOOK_BUILD_COMMIT");
    expect(entryPoint).not.toMatch(/HOOK_BUILD_COMMIT\s*=/);
  });

  it("answers --build-commit before it reads stdin", () => {
    // Order is load-bearing and not cosmetic. `standup-hook.ts` reads stdin
    // to the end on the hook path; a `--build-commit` handled after that read
    // would hang forever when a checker invokes it with no stdin, which is
    // exactly how `check-hook-freshness.mjs` calls it. The protocol-version
    // flag has the same constraint for the same reason.
    const buildCommitAt = entryPoint.indexOf('"--build-commit"');
    const readStdinAt = entryPoint.indexOf("await readStdin()");
    expect(buildCommitAt).toBeGreaterThan(-1);
    expect(readStdinAt).toBeGreaterThan(-1);
    expect(buildCommitAt).toBeLessThan(readStdinAt);
  });
});

describe("the stamp in a genuinely built artifact", () => {
  // The half that cannot be faked by reading source: esbuild's `define` is a
  // textual substitution, so only a real build proves the token was actually
  // replaced. Everything above would still pass against a bundler whose
  // `define` key was misspelled — the artifact would simply carry the
  // sentinel forever, which is precisely the silent-nothing failure mode.
  const artifact = path.join(repoRoot, HOOK_SCRIPTS_DIR, "http.js");

  /** Builds the hook scripts once for this block, returning the stamp used. */
  function buildOnce(): string {
    const stdout = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "build-hook-scripts.mjs")],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    void stdout;
    return resolveBuildCommit();
  }

  it("prints the commit it was built from, and exits zero", () => {
    const expected = buildOnce();
    const printed = execFileSync(process.execPath, [artifact, "--build-commit"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    // Not merely "some sha": the sha this checkout is actually at. A build
    // that stamped a hard-coded or stale value would match a loose shape
    // assertion and fail this one.
    expect(printed).toBe(expected);
    expect(isStamped(printed)).toBe(true);
  });

  it("is a 40-character sha, optionally marked dirty", () => {
    buildOnce();
    const printed = execFileSync(process.execPath, [artifact, "--build-commit"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // The shape `check-hook-freshness.mjs` parses back. If these two ever
    // disagree the checker silently reports every artifact as unreadable.
    expect(printed).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
  });

  it("does not leave the substitution token in the artifact", () => {
    buildOnce();
    const bundle = readFileSync(artifact, "utf-8");
    // If `define` did not fire, the identifier survives into the bundle and
    // the artifact throws a ReferenceError on `--build-commit` — or worse,
    // reports the sentinel while looking built.
    expect(bundle).not.toContain("__STANDUP_HOOK_BUILD_COMMIT__");
  });

  it("still answers --protocol-version, which the stamp did not displace", () => {
    // The regression guard for the flag that already existed. Both are
    // answered before stdin, and an edit to one is the likeliest way to
    // break the other.
    buildOnce();
    const printed = execFileSync(process.execPath, [artifact, "--protocol-version"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    expect(printed).toMatch(/^\d+$/);
  });

  it("builds every declared variant, so no variant ships unstamped", () => {
    buildOnce();
    for (const variant of Object.keys(HOOK_SCRIPT_ENTRY_POINTS)) {
      const built = path.join(repoRoot, HOOK_SCRIPTS_DIR, `${variant}.js`);
      const printed = execFileSync(process.execPath, [built, "--build-commit"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      expect(isStamped(printed)).toBe(true);
    }
  });
});
