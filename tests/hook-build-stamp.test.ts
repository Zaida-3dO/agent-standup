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

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_BUILD_COMMIT, UNSTAMPED, formatBuildStamp, isStamped } from "@/lib/hook/build-stamp";
import {
  HOOK_SCRIPTS_DIR,
  HOOK_SCRIPT_ENTRY_POINTS,
  UNSTAMPED as BUILDER_UNSTAMPED,
  resolveBuildCommit,
} from "../scripts/build-hook-scripts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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
    writeFileSync(path.join(scratch, "a.txt"), "one\n", "utf-8");
    git("add", "a.txt");
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
    writeFileSync(path.join(scratch, "a.txt"), "two\n", "utf-8");
    expect(resolveIn()).toBe(`${head}-dirty`);

    // An untracked file counts too: it can be bundled, so a build made with
    // one present is no more reproducible than one with a modified file.
    writeFileSync(path.join(scratch, "a.txt"), "one\n", "utf-8");
    expect(resolveIn()).toBe(head);
    writeFileSync(path.join(scratch, "untracked.txt"), "new\n", "utf-8");
    expect(resolveIn()).toBe(`${head}-dirty`);
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
