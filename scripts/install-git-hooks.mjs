#!/usr/bin/env node
/**
 * Points git at `.githooks/` so the pre-push gate (format:check + lint) runs
 * automatically, without a documented manual step. Runs as the `prepare` npm
 * script, so it fires on every `npm install`/`npm ci` a contributor runs —
 * the same moment dependencies land, which is the only way a hook nobody
 * remembers to wire up still ends up wired up.
 *
 * Plain `git config core.hooksPath .githooks` rather than a hook-manager
 * dependency: one git call does the whole job, and git runs a hooks-path
 * script directly with `sh` on both Windows (Git for Windows ships one) and
 * Linux, so there is nothing else to install or branch on per platform.
 *
 * Deliberately a no-op, not a failure, when there is no `.git` to configure
 * (e.g. installing from a tarball, or a Docker build stage that runs
 * `npm ci` without repo history) — dependency installs must not start
 * failing because of a repo layout that was never going to push anyway.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) {
  console.log("install-git-hooks: no .git directory here, skipping (not a git checkout)");
  process.exit(0);
}

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  console.log("install-git-hooks: core.hooksPath -> .githooks (pre-push runs format:check + lint)");
} catch (err) {
  console.warn(
    "install-git-hooks: could not set core.hooksPath, pre-push gate will not run locally",
  );
  console.warn(String(err && err.message ? err.message : err));
  // Non-fatal: a contributor who can't get the hook wired up should still be
  // able to install dependencies and work. CI runs these checks regardless.
}
