// The freshness checker: **a stale vendored artifact is told it is stale,
// in words that name what to do about it.**
//
// ── Why this check cannot live in CI, and what that means for its tests ─
//
// CI checks out this repository and builds from it, so any artifact CI makes
// is current by construction. The assertion "the artifact matches the source"
// is one CI can never fail — and a check that cannot fail is the exact thing
// this row is about. The stale artifact did not live here at all: it lived in
// a different repository, on a different machine, vendored by a `curl` nobody
// re-ran.
//
// So the checker runs where the artifact is *consumed*, and takes the
// artifact as an argument. What this file can test is therefore the
// **decision**, not the deployment: `assessFreshness` is pure apart from the
// git lookups handed to it, so every verdict is reachable without a build, a
// network, or a second repository.
//
// ── The property that matters most ─────────────────────────────────────
//
// Every non-fresh verdict must exit non-zero, *including* the ones that mean
// "I could not tell". An artifact that cannot say what it is has precisely
// the property that caused the incident, and treating "unknown" as
// "probably fine" is the assumption being removed. Several tests below exist
// only to pin that, because the tempting simplification — treat unstamped as
// a pass so old artifacts do not nag — would reintroduce the whole bug.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS on purpose, matching `scripts/check-external-refs.mjs`: this has
// to run as `node scripts/check-hook-freshness.mjs` against a vendored file
// in another repository, with no build step and no TypeScript toolchain.
import {
  HOOK_SOURCE_PATHS,
  UNSTAMPED,
  assessFreshness,
  parseStamp,
} from "../scripts/check-hook-freshness.mjs";

const SHA = "e67b0184368ecd7b0af210aba42e30c01a29e64c";
const OTHER_SHA = "654aeb2f00000000000000000000000000000000";

const scriptPath = path.resolve(import.meta.dirname, "../scripts/check-hook-freshness.mjs");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * What `assessFreshness` is handed. Written out rather than derived with
 * `Parameters<typeof assessFreshness>` because the checker is plain `.mjs`
 * with no annotations, so that helper infers `undefined` and every call below
 * becomes a type error.
 */
type FreshnessInput = {
  stamp: string;
  headCommit: string;
  isAncestor: (commit: string) => boolean;
  commitsTouchingHookSince: (commit: string) => string[];
};

/** Default collaborators: a clean checkout at SHA with nothing outstanding. */
function deps(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    stamp: SHA,
    headCommit: SHA,
    isAncestor: () => true,
    commitsTouchingHookSince: () => [],
    ...overrides,
  };
}

describe("parsing a stamp", () => {
  it("splits a dirty stamp into its commit and its dirtiness", () => {
    expect(parseStamp(`${SHA}-dirty`)).toEqual({ commit: SHA, dirty: true });
  });

  it("reads a clean stamp as a commit that is not dirty", () => {
    expect(parseStamp(SHA)).toEqual({ commit: SHA, dirty: false });
  });

  it("yields no commit for the sentinel or for silence", () => {
    expect(parseStamp(UNSTAMPED).commit).toBeUndefined();
    expect(parseStamp("").commit).toBeUndefined();
  });
});

describe("the freshness verdict", () => {
  it("passes an artifact built from a commit that includes every hook change", () => {
    const verdict = assessFreshness(deps());
    expect(verdict.fresh).toBe(true);
    expect(verdict.code).toBe("fresh");
    // The one case that is allowed to exit zero. If this test ever needs
    // changing to make a suite pass, the checker has stopped being usable.
    expect(verdict.message).toContain(SHA);
  });

  it("fails an artifact that is behind commits touching the hook", () => {
    // The incident itself, as a decision: a build from before `654aeb2`
    // with the capture loop landed after it.
    const verdict = assessFreshness(
      deps({
        stamp: OTHER_SHA,
        commitsTouchingHookSince: () => ["654aeb2 add the capture loop"],
      }),
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.code).toBe("stale");
    // The message must name the missing work, not just assert staleness —
    // the reader's next question is always "missing what?".
    expect(verdict.message).toContain("654aeb2");
    expect(verdict.message).toContain("capture loop");
  });

  it("counts every missed commit rather than reporting only the first", () => {
    const verdict = assessFreshness(
      deps({
        stamp: OTHER_SHA,
        commitsTouchingHookSince: () => ["aaa1111 one", "bbb2222 two", "ccc3333 three"],
      }),
    );
    expect(verdict.code).toBe("stale");
    expect(verdict.message).toContain("3 commit(s)");
    expect(verdict.message).toContain("bbb2222");
    expect(verdict.message).toContain("ccc3333");
  });

  it("fails an artifact that reports no build commit at all", () => {
    // The pre-stamp build. Treating this as a pass is the tempting
    // simplification that would reintroduce the bug wholesale, since every
    // artifact built before this feature reports exactly this.
    const verdict = assessFreshness(deps({ stamp: UNSTAMPED }));
    expect(verdict.fresh).toBe(false);
    expect(verdict.code).toBe("unstamped");
  });

  it("fails an artifact too old to recognise the question", () => {
    // Distinct from `unstamped`: this build does not know `--build-commit`
    // exists, so it printed a hook verdict or nothing. Reported separately
    // because the remedy is the same but the diagnosis is not.
    const verdict = assessFreshness(deps({ stamp: "" }));
    expect(verdict.fresh).toBe(false);
    expect(verdict.code).toBe("unreadable");
  });

  it("fails an artifact built from a dirty tree even when the commit is current", () => {
    // Everything else about this build is right — the commit is HEAD, it is
    // an ancestor, nothing has landed since. It still fails, because a build
    // from a modified tree is not reproducible from any commit and nothing
    // can say what is in it.
    const verdict = assessFreshness(deps({ stamp: `${SHA}-dirty` }));
    expect(verdict.fresh).toBe(false);
    expect(verdict.code).toBe("dirty");
    expect(verdict.message).toContain(SHA);
  });

  it("fails an artifact built from a commit this checkout does not contain", () => {
    const verdict = assessFreshness(
      deps({ stamp: OTHER_SHA, isAncestor: () => false, headCommit: SHA }),
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.code).toBe("unknown-commit");
    // Both commits named, because the reader needs to know which branch they
    // are comparing against.
    expect(verdict.message).toContain(OTHER_SHA);
    expect(verdict.message).toContain(SHA);
  });

  it("checks dirtiness before ancestry, so a dirty build is not mislabelled", () => {
    // Ordering assertion. A dirty build of an unpushed commit is dirty
    // first — reporting `unknown-commit` would send the reader to look for a
    // branch when the real problem is uncommitted edits on their own disk.
    const verdict = assessFreshness(deps({ stamp: `${OTHER_SHA}-dirty`, isAncestor: () => false }));
    expect(verdict.code).toBe("dirty");
  });

  it("does not consult git about a stamp that names no commit", () => {
    // A stamp with no commit cannot be looked up, and asking anyway would
    // throw inside the checker — turning a clear verdict into a crash.
    const verdict = assessFreshness(
      deps({
        stamp: UNSTAMPED,
        isAncestor: () => {
          throw new Error("must not ask git about a commit that does not exist");
        },
        commitsTouchingHookSince: () => {
          throw new Error("must not ask git about a commit that does not exist");
        },
      }),
    );
    expect(verdict.code).toBe("unstamped");
  });

  it("every non-fresh verdict carries a remedy the reader can act on", () => {
    // The refusal-quality property this workspace keeps re-learning: a check
    // that says "no" without saying "do this" costs the reader a round trip.
    for (const stamp of [UNSTAMPED, "", `${SHA}-dirty`]) {
      const verdict = assessFreshness(deps({ stamp }));
      expect(verdict.fresh).toBe(false);
      expect(verdict.message).toMatch(/re-vendor|Build from a clean tree/i);
    }
  });
});

describe("the source paths that decide staleness", () => {
  it("includes the hook entry point and the bundler itself", () => {
    // The bundler is in the list because a change to *how* the artifact is
    // built makes an existing artifact stale just as surely as a change to
    // what goes in it — including, recursively, a change to the stamping.
    expect(HOOK_SOURCE_PATHS).toContain("src/bin/standup-hook.ts");
    expect(HOOK_SOURCE_PATHS).toContain("scripts/build-hook-scripts.mjs");
  });

  it("includes the trees the incident's missing feature actually lived in", () => {
    // `buildCaptures` is imported from `@/lib/interventions/capture`. Had
    // that tree been missing from this list, the checker would have passed
    // the very artifact that motivated it.
    expect(HOOK_SOURCE_PATHS).toContain("src/lib/interventions");
    expect(HOOK_SOURCE_PATHS).toContain("src/lib/hook");
  });

  it("is narrower than the whole repository", () => {
    // Deliberate: an artifact does not go stale because a migration or a
    // React component landed, and telling a consumer to re-vendor for a
    // README change trains them to ignore the check.
    expect(HOOK_SOURCE_PATHS).not.toContain("src");
    expect(HOOK_SOURCE_PATHS).not.toContain(".");
  });
});

describe("the checker as a process", () => {
  /** Runs the checker the way a consumer's repo would. */
  function runCli(args: string[], cwd = process.cwd()) {
    try {
      const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }

  it("exits non-zero and explains itself when given no artifact", () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage");
  });

  it("exits non-zero for an artifact that is not there", () => {
    // The vendoring-path-changed case. Silently passing a missing file would
    // mean a consumer who moved their hook gets a green tick forever.
    const result = runCli([path.join(tmpdir(), "definitely-not-a-hook-artifact.mjs")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no such artifact");
  });

  it("exits non-zero for a file that is not a hook at all", () => {
    // A vendored file that got truncated, or replaced by an error page from
    // a failed curl. It answers nothing, so it is unreadable.
    const dir = mkdtempSync(path.join(tmpdir(), "hook-freshness-"));
    tempDirs.push(dir);
    const file = path.join(dir, "not-a-hook.mjs");
    writeFileSync(file, "process.stdout.write('hello');\n", "utf8");

    const result = runCli([file]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("UNREADABLE");
  });

  it("reports STALE against --expect when the artifact names another commit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hook-freshness-expect-"));
    tempDirs.push(dir);
    const file = path.join(dir, "stamped.mjs");
    // A stand-in that answers the flag the way a built artifact does, so the
    // pinned-version path is exercised without needing a real build here.
    writeFileSync(file, `process.stdout.write(${JSON.stringify(SHA)});\n`, "utf8");

    const matching = runCli([file, "--expect", SHA]);
    expect(matching.status).toBe(0);
    expect(matching.stdout).toContain("OK");

    const mismatched = runCli([file, "--expect", OTHER_SHA]);
    expect(mismatched.status).toBe(1);
    expect(mismatched.stdout).toContain("STALE");
    expect(mismatched.stdout).toContain(OTHER_SHA);
  });
});
