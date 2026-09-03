#!/usr/bin/env node
/**
 * Asks a built hook artifact which source it was built from, and says so —
 * loudly — when that is not the source it is supposed to be exercising.
 *
 * ── The failure ─────────────────────────────────────────────────────────
 *
 * A vendored copy of `standup-hook.http.mjs` sat on a machine for eight days
 * carrying a build made *before* the capture loop it was supposed to
 * exercise (`654aeb2`, PR #317). It contained zero occurrences of `capture`.
 * Every session ran it, on `PreToolUse`, `PostToolUse` and `Stop`; it exited
 * 0 every time; it recorded nothing. A board row waited on the evidence it
 * could never produce and read as healthy throughout — recently unpaused,
 * blocker removed, evidence accumulating. Every one of those statements was
 * true about the code and false about the deployment.
 *
 * The general shape, which this repository keeps finding: **a thing that is
 * not happening presents identically to a thing happening slowly.** A
 * path-filtered CI job rendering green when skipped is the same bug. A no-op
 * that cannot be told from a pass is the same bug.
 *
 * ── Why this is a script and not a CI assertion ─────────────────────────
 *
 * This was the design decision worth getting right, and the obvious answer
 * is the wrong one.
 *
 * CI cannot see this failure. CI checks out the product repository and
 * builds from it, so a build it makes is current *by construction* — the
 * assertion "the artifact matches the source" is one CI can never fail, and
 * a check that cannot fail is precisely the thing this row is about. The
 * stale artifact did not live in this repository at all. It lived in a
 * different repository on a different machine, vendored by a `curl` that
 * nobody re-ran. No amount of checking here would have said a word about it,
 * and adding a green tick in CI would actively have made things worse: one
 * more signal reading healthy while the deployment rotted.
 *
 * So the check has to run **where the artifact is consumed**, against the
 * artifact actually on disk, comparing it to a source of truth outside
 * itself. That is what this script does, and why it takes the artifact as an
 * argument rather than assuming a path: the thing being checked is a file
 * some *other* repository vendored.
 *
 * The startup-check alternative — have the hook verify itself on every
 * firing — was rejected. The hook runs on every tool call of every session
 * and its own header commits to staying off the critical path; making it
 * shell out to `git` or reach the network to check its own freshness would
 * put a subprocess in front of every tool call to answer a question whose
 * answer changes only when someone re-vendors. Worse, a stale build cannot
 * be relied on to check itself: the failure mode is *old code running*, and
 * old code does not contain tomorrow's check. A build from before this
 * script existed has no self-check in it — which is exactly the case that
 * needs catching.
 *
 * ── What it compares against ────────────────────────────────────────────
 *
 * Two modes, because there are two different questions:
 *
 *   --expect <commit>   the artifact must be built from this exact commit.
 *                       For a consumer that pins a version.
 *
 *   --repo <path>       the artifact must be built from a commit that is an
 *                       ancestor of, or equal to, that checkout's HEAD, and
 *                       must not be behind any commit touching the hook's
 *                       own sources. This is the useful one: it answers "is
 *                       the vendored copy missing anything" rather than
 *                       "is it byte-identical to my working tree", so a
 *                       consumer is not told to re-vendor for a commit that
 *                       changed only the README.
 *
 * ── Exit codes ──────────────────────────────────────────────────────────
 *
 *   0  fresh — the artifact is built from source that includes every commit
 *      touching the hook.
 *   1  stale, unstamped, or unreadable — something a person must act on.
 *
 * A non-zero exit is deliberate for `unstamped` as well as for `stale`.
 * An artifact that cannot say what it is has exactly the property that
 * caused this incident, and treating "I don't know" as "probably fine" is
 * the assumption this whole row exists to stop being made.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Matches `resolveBuildCommit`'s output for a build made outside a checkout. */
export const UNSTAMPED = "unstamped";

/**
 * The paths whose history decides whether a hook build is behind.
 *
 * Deliberately narrower than the whole repository. A hook artifact does not
 * become stale because a migration or a React component landed, and telling
 * a consumer to re-vendor for a commit that cannot have changed the bundle
 * trains them to ignore the check — which costs more than the rare
 * false-negative this risks. These are the trees esbuild actually pulls
 * into the bundle, plus the bundler itself.
 */
export const HOOK_SOURCE_PATHS = Object.freeze([
  "src/bin/standup-hook.ts",
  "src/lib/hook",
  "src/lib/interventions",
  "src/lib/cli/hook-command.ts",
  "src/lib/cli/spool-file.ts",
  "src/lib/build-constants.ts",
  "scripts/build-hook-scripts.mjs",
]);

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Asks a built artifact which commit it came from, by running it.
 *
 * Running it — rather than grepping it for a SHA-shaped string — is what
 * makes this a question the artifact *answers* rather than one a checker
 * guesses at. A regex over the bundle would match a commit SHA appearing in
 * any inlined comment or string and would report the wrong build with total
 * confidence.
 */
export function readArtifactStamp(artifactPath, { nodeBin = process.execPath } = {}) {
  const raw = execFileSync(nodeBin, [artifactPath, "--build-commit"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  // An artifact built before `--build-commit` existed does not recognise the
  // flag. It reads stdin instead, gets EOF from the ignored handle, and
  // prints a hook verdict — or nothing at all. Either way what comes back is
  // not a stamp, and "this build is too old to be able to tell you how old
  // it is" is itself the answer.
  return /^[0-9a-f]{40}(-dirty)?$/.test(raw) || raw === UNSTAMPED ? raw : "";
}

/** Splits a stamp into its commit and whether the build's tree was dirty. */
export function parseStamp(stamp) {
  if (stamp === "" || stamp === UNSTAMPED) return { commit: undefined, dirty: false };
  const dirty = stamp.endsWith("-dirty");
  return { commit: dirty ? stamp.slice(0, -"-dirty".length) : stamp, dirty };
}

/**
 * Decides freshness of a stamp against a checkout.
 *
 * Pure apart from the `git` calls it is handed, so the decision table is
 * testable without a build, an artifact or a subprocess.
 */
export function assessFreshness({ stamp, headCommit, isAncestor, commitsTouchingHookSince }) {
  const { commit, dirty } = parseStamp(stamp);

  if (stamp === "") {
    return {
      fresh: false,
      code: "unreadable",
      message:
        "The artifact did not answer --build-commit. It is from a build older than the build stamp itself, " +
        "so it cannot report what it is — which is the condition this check exists to catch. Re-vendor it.",
    };
  }

  if (commit === undefined) {
    return {
      fresh: false,
      code: "unstamped",
      message:
        "The artifact reports no build commit, so its provenance is unknown. " +
        "An unknown build is treated as stale rather than as probably-fine: that assumption is what let a " +
        "hook eight days older than the feature it exercised run in silence. " +
        "Re-vendor it from a build made inside a git checkout.",
    };
  }

  if (dirty) {
    return {
      fresh: false,
      code: "dirty",
      message:
        `The artifact was built from ${commit} with uncommitted changes, so it is not reproducible from any ` +
        "commit and nothing can say what is actually in it. Build from a clean tree and re-vendor.",
    };
  }

  if (!isAncestor(commit)) {
    return {
      fresh: false,
      code: "unknown-commit",
      message:
        `The artifact was built from ${commit}, which is not an ancestor of HEAD (${headCommit}). ` +
        "It is from a branch this checkout does not contain, so it cannot be compared — re-vendor from a build of this branch.",
    };
  }

  const missed = commitsTouchingHookSince(commit);
  if (missed.length > 0) {
    return {
      fresh: false,
      code: "stale",
      message:
        `The artifact was built from ${commit}, which is behind ${missed.length} commit(s) that changed the hook:\n` +
        missed.map((line) => `  ${line}`).join("\n") +
        "\nEverything those commits added is absent from the artifact, and a hook missing a feature fails by " +
        "doing nothing and saying nothing. Re-vendor it.",
    };
  }

  return {
    fresh: true,
    code: "fresh",
    message: `The artifact was built from ${commit} and includes every commit that touches the hook.`,
  };
}

function parseArgs(argv) {
  const args = { artifact: undefined, repo: undefined, expect: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = argv[(i += 1)];
    else if (arg === "--expect") args.expect = argv[(i += 1)];
    else if (!arg.startsWith("--")) args.artifact = arg;
  }
  return args;
}

function main(argv) {
  const { artifact, repo, expect } = parseArgs(argv);

  if (artifact === undefined) {
    process.stderr.write(
      "usage: check-hook-freshness.mjs <artifact.mjs> [--repo <checkout>] [--expect <commit>]\n" +
        "  Verifies a built hook artifact is not older than the hook sources it is meant to exercise.\n",
    );
    return 1;
  }
  if (!existsSync(artifact)) {
    process.stderr.write(`hook freshness: no such artifact: ${artifact}\n`);
    return 1;
  }

  const repoRoot = repo ?? process.cwd();
  const stamp = readArtifactStamp(artifact);

  if (expect !== undefined) {
    const { commit } = parseStamp(stamp);
    const ok = commit === expect;
    process.stdout.write(
      ok
        ? `hook freshness: OK — built from the expected commit ${expect}.\n`
        : `hook freshness: STALE — expected ${expect}, artifact reports ${stamp === "" ? "no answer" : stamp}.\n`,
    );
    return ok ? 0 : 1;
  }

  const verdict = assessFreshness({
    stamp,
    headCommit: git(repoRoot, ["rev-parse", "HEAD"]),
    isAncestor: (commit) => {
      try {
        git(repoRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]);
        return true;
      } catch {
        return false;
      }
    },
    commitsTouchingHookSince: (commit) => {
      const out = git(repoRoot, [
        "log",
        "--oneline",
        `${commit}..HEAD`,
        "--",
        ...HOOK_SOURCE_PATHS,
      ]);
      return out === "" ? [] : out.split("\n");
    },
  });

  process.stdout.write(
    `hook freshness: ${verdict.fresh ? "OK" : verdict.code.toUpperCase()} — ${verdict.message}\n`,
  );
  return verdict.fresh ? 0 : 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    // Loud, not silent, and non-zero. This script's entire purpose is to
    // stop an unanswered question reading as a pass, so it must not become
    // an example of one itself.
    process.stderr.write(`hook freshness: check failed to run — ${String(error)}\n`);
    process.exit(1);
  }
}
