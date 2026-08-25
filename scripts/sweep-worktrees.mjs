#!/usr/bin/env node
/**
 * Removes the git worktrees that finished crews leave behind, without ever
 * removing one that still holds unmerged or uncommitted work.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Every crew works in its own `git worktree` (see CLAUDE.md, "Don't pull the
 * ground out from under a running crew"). Tearing one down is nobody's job
 * on the happy path: a crew that has opened its PR has finished, and an
 * agent that has been torn down cannot clean up after itself at all. Nothing
 * else removes them, so the leak is monotonic — by 2026-08-25 eighty of them
 * had accumulated, of which sixty-three held commits that were not on main.
 *
 * `git worktree prune` does not help. Prune only clears registry entries
 * whose directory has gone; these all still exist on disk, so it removes
 * none of them.
 *
 * ── Why removing them is genuinely dangerous ────────────────────────────
 *
 * A finished worktree and a live one are INDISTINGUISHABLE BY NAME. Branch
 * names outlive their work in both directions: `fix/foo` may have merged
 * days ago, or may be the only copy of work a crew is still writing. So the
 * obvious approach — list the merged-looking ones, then remove the list — is
 * unsafe in exactly the way that matters: the list is a snapshot, and
 * between taking it and acting on it a crew can write into a worktree that
 * was clean when it was listed.
 *
 * That is not hypothetical. On 2026-08-25 this sweep's own first run found
 * two worktrees (`as-wt-trustbadge-doc`, `as-wt-visual2`) that were clean at
 * classification time and dirty by the time removal reached them, seconds
 * later. A precomputed-list sweep would have destroyed that work. The same
 * day, a crew lost ~200 lines to a single `git checkout`, and a reviewer
 * destroyed two scratch databases that were not its own.
 *
 * ── The three independent guards ────────────────────────────────────────
 *
 * All must pass for a worktree to be removed, and all are evaluated at
 * REMOVE TIME rather than at list time:
 *
 *   1. **Clean.** `git status --porcelain` re-run immediately before each
 *      individual removal, not once for the whole batch. Any uncommitted
 *      change at all — tracked or untracked — and it is skipped and
 *      reported. This is the guard that caught the two above.
 *
 *   2. **Work is present on the base branch.** Not `git branch --merged`,
 *      which answers a question about ancestry and misses every squash
 *      merge — and squash is how this repo merges, so ancestry alone found
 *      4 of the 21 worktrees that were genuinely merged. Instead, for each
 *      file the branch changed relative to its merge-base, compare the
 *      branch's blob to the base branch's blob. If every one is identical,
 *      the branch's content is on the base branch however it got there.
 *
 *   3. **No live process.** A worktree that any running process references
 *      is skipped even when it is clean and merged — a crew between two
 *      commits is invisible to guard 1 but plainly visible as a running
 *      `vitest`. On the first run this guard alone saved
 *      `wt-t20-archive-mobile`, which was fully merged and clean but had a
 *      test run in flight.
 *
 * Branch refs are deliberately NEVER deleted. Removing a worktree only
 * removes the checkout; `git worktree add <path> <branch>` restores it. That
 * asymmetry is the point — it makes every action this script takes
 * reversible, so the worst case is inconvenience rather than lost work.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * Only worktrees registered to this repository, never the main checkout
 * itself. A worktree whose state this script cannot determine — an
 * unresolvable HEAD, no merge-base with the base branch, a directory it
 * cannot read — is reported and left alone rather than guessed at.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *
 *   node scripts/sweep-worktrees.mjs                  # dry run: report only
 *   node scripts/sweep-worktrees.mjs --apply          # actually remove
 *   node scripts/sweep-worktrees.mjs --base origin/main
 *
 * Dry run is the default on purpose: the first thing anyone should see is
 * the list, not the aftermath.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Runs a git command and returns stdout, or null if it failed. */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--base");
  const base = i === -1 ? "origin/main" : argv[i + 1];
  if (!base) throw new Error("--base needs a ref");
  return { apply, base };
}

/** Every registered worktree except the main checkout. */
function listWorktrees(repo) {
  const out = git(["worktree", "list", "--porcelain"], repo);
  if (out === null) throw new Error("could not list worktrees");
  const entries = [];
  let current = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length).trim() };
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch "))
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    else if (line.startsWith("detached")) current.branch = null;
    else if (line.trim() === "" && current.path) {
      entries.push(current);
      current = {};
    }
  }
  if (current.path) entries.push(current);
  // The first entry is always the main checkout; never a removal candidate.
  return entries.slice(1);
}

/**
 * Command lines of every running process, lowercased, with NUL bytes
 * stripped.
 *
 * The strip is load-bearing on Windows: the raw CIM output carries NULs, and
 * a tool that treats the result as binary will refuse to match rather than
 * matching nothing — a guard that aborts looks the same as a guard that
 * passes unless you check. The first version of this sweep had exactly that
 * bug; its process check crashed on every iteration and protected nothing.
 * If the snapshot cannot be taken at all we return null, and the caller
 * treats that as "cannot determine" and skips every removal, rather than
 * proceeding without the guard.
 */
function processSnapshot() {
  const commands =
    process.platform === "win32"
      ? [
          [
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
            ],
          ],
        ]
      : [["ps", ["-eo", "args"]]];
  for (const [cmd, args] of commands) {
    try {
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
      return out.replace(/\0/g, "").toLowerCase();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** True if any running process references this worktree path. */
function hasLiveProcess(snapshot, worktreePath) {
  const forward = worktreePath.toLowerCase().replace(/\\/g, "/");
  const backward = forward.replace(/\//g, "\\");
  return snapshot.includes(forward) || snapshot.includes(backward);
}

/**
 * How many of the files this branch changed still differ from the base.
 *
 * Zero means the branch's content is present on the base branch — the test
 * that recognises a squash merge, which ancestry cannot. Returns null when
 * the comparison cannot be made, which the caller treats as "leave it".
 */
function filesStillDiffering(repo, head, base) {
  const mergeBase = git(["merge-base", base, head], repo)?.trim();
  if (!mergeBase) return null;
  const changed = git(["diff", "--name-only", mergeBase, head], repo);
  if (changed === null) return null;
  const files = changed.split("\n").filter(Boolean);
  let differing = 0;
  for (const file of files) {
    const onBranch = git(["rev-parse", `${head}:${file}`], repo)?.trim() ?? null;
    const onBase = git(["rev-parse", `${base}:${file}`], repo)?.trim() ?? null;
    if (onBranch !== onBase) differing += 1;
  }
  return differing;
}

function main() {
  const { apply, base } = parseArgs(process.argv.slice(2));
  const repo = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    process.cwd(),
  )?.trim();
  if (!repo) throw new Error("not inside a git repository");
  const mainCheckout = git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    process.cwd(),
  )?.trim();

  git(["fetch", "origin", "--quiet"], mainCheckout);
  const baseSha = git(["rev-parse", base], mainCheckout)?.trim();
  if (!baseSha) throw new Error(`could not resolve base ref ${base}`);

  const snapshot = processSnapshot();
  if (snapshot === null) {
    console.error("Could not take a process snapshot — refusing to remove anything.");
    console.error(
      "The live-process guard cannot be evaluated, and a guard that cannot run is not a guard.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`base ${base} = ${baseSha}`);
  console.log(apply ? "mode: APPLY\n" : "mode: dry run (pass --apply to remove)\n");

  const removed = [];
  const kept = [];

  for (const wt of listWorktrees(mainCheckout)) {
    const label = `${wt.path}${wt.branch ? ` [${wt.branch}]` : " (detached)"}`;

    if (!existsSync(wt.path)) {
      kept.push([label, "directory is gone — `git worktree prune` handles this"]);
      continue;
    }
    if (hasLiveProcess(snapshot, wt.path)) {
      kept.push([label, "a running process references it"]);
      continue;
    }
    const status = git(["status", "--porcelain"], wt.path);
    if (status === null) {
      kept.push([label, "could not read its status"]);
      continue;
    }
    const dirty = status.split("\n").filter(Boolean).length;
    if (dirty > 0) {
      kept.push([label, `${dirty} uncommitted change(s)`]);
      continue;
    }
    const head = git(["rev-parse", "HEAD"], wt.path)?.trim();
    if (!head) {
      kept.push([label, "could not resolve HEAD"]);
      continue;
    }
    const differing = filesStillDiffering(mainCheckout, head, baseSha);
    if (differing === null) {
      kept.push([label, `no merge-base with ${base} — cannot tell if its work is safe`]);
      continue;
    }
    if (differing > 0) {
      kept.push([
        label,
        `${differing} file(s) differ from ${base} — work is not on the base branch`,
      ]);
      continue;
    }

    if (!apply) {
      removed.push([label, "would remove: clean, no live process, content present on base"]);
      continue;
    }

    // Re-check cleanliness one final time, immediately before the removal
    // itself. Everything above is still a snapshot the moment it is read.
    const finalStatus = git(["status", "--porcelain"], wt.path);
    if (finalStatus === null || finalStatus.split("\n").filter(Boolean).length > 0) {
      kept.push([label, "became dirty between the check and the removal"]);
      continue;
    }
    if (git(["worktree", "remove", wt.path], mainCheckout) === null) {
      kept.push([label, "git worktree remove failed"]);
      continue;
    }
    removed.push([label, `removed (branch ref kept — restore with \`git worktree add\`)`]);
  }

  if (removed.length) {
    console.log(apply ? "Removed:" : "Would remove:");
    for (const [label, why] of removed) console.log(`  ${label}\n    ${why}`);
    console.log("");
  }
  if (kept.length) {
    console.log("Left alone:");
    for (const [label, why] of kept) console.log(`  ${label}\n    ${why}`);
    console.log("");
  }
  console.log(`${removed.length} ${apply ? "removed" : "removable"}, ${kept.length} left alone.`);
}

main();
