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
 * ── The guards ──────────────────────────────────────────────────────────
 *
 * All must pass for a worktree to be removed, and all are evaluated at
 * REMOVE TIME rather than at list time:
 *
 *   1. **The work is merged.** Satisfied by EITHER of two signals, because
 *      each misses what the other catches — and notably neither is ancestry.
 *      Of the 55 merged worktrees measured here, `git branch --merged`
 *      recognised 4, the content comparison 21, and the pull-request record
 *      all 55.
 *        - Its pull request is `MERGED`. Stays true however far the base
 *          branch moves on. A `CLOSED` pull request is NOT merged and is
 *          refused outright — see `pullRequestStates`.
 *        - Or every file the branch changed is byte-identical on the base
 *          branch. Needs no network and no `gh`, but only recognises a
 *          squash merge while nothing else has since edited those files.
 *
 *   2. **Clean.** `git status --porcelain` re-run immediately before each
 *      individual removal, not once for the whole batch. Any uncommitted
 *      change at all — tracked or untracked — and it is skipped and
 *      reported. This is the guard that caught the two above.
 *
 *   3. **No live process.** A worktree that any running process references
 *      is skipped even when it is clean and merged — a crew between two
 *      commits is invisible to guard 1 but plainly visible as a running
 *      `vitest`. On the first run this guard alone saved
 *      `wt-t20-archive-mobile`, which was fully merged and clean but had a
 *      test run in flight.
 *
 *   4. **git's own refusal.** Removal calls `git worktree remove` WITHOUT
 *      `--force`, so git refuses outright to delete a tree holding modified
 *      or untracked files. This is the strongest guard here and the only one
 *      that does not depend on this script being correct: it closes the
 *      residual race between guard 2 and the delete, and it still holds when
 *      guard 3 misses a crew it cannot see. **Never add `--force`.**
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
import { pathToFileURL } from "node:url";

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
 *
 * Returns null whenever the answer cannot be trusted, and the caller treats
 * null as "cannot determine" and removes nothing at all. Three ways to get
 * there, and the last two are the same mistake as the NUL bug one layer out:
 *
 *   - the command throws;
 *   - it exits 0 having printed nothing;
 *   - it prints something that plainly is not a process list.
 *
 * The middle case is the dangerous one. An empty string is a perfectly good
 * string, so a permissive check like `snapshot === null` accepts it, and
 * every worktree then reads as "no process references this" — the permissive
 * answer, returned precisely when we know least. A sanity floor (does this
 * look like a process list at all?) is what turns "I got nothing back" into
 * a refusal instead of an all-clear.
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
      const cleaned = out.replace(/\0/g, "").toLowerCase();
      if (!looksLikeProcessList(cleaned)) continue;
      return cleaned;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * A floor on what counts as a usable process snapshot.
 *
 * This process is itself a running process, so ANY genuine listing contains
 * at least one line naming a node binary. That makes it a self-verifying
 * check: if the snapshot cannot see the process taking it, it cannot see
 * anything, and reporting "no live processes" from it would be a guarantee
 * we do not have.
 */
function looksLikeProcessList(snapshot) {
  if (snapshot.trim().length === 0) return false;
  return snapshot.includes("node");
}

/**
 * True if any running process appears to reference this worktree.
 *
 * Matches the absolute path in either slash direction, and also the
 * directory's own name. The basename match is what catches the common shape
 * the path match cannot: a crew that ran `npx vitest run` from inside its
 * worktree has a command line carrying no path at all, but the tool it
 * spawned almost always names the directory somewhere in its argv.
 *
 * ── What this CANNOT see, stated plainly ────────────────────────────────
 *
 * This is a heuristic over command lines, not a handle table. Windows'
 * `Win32_Process` exposes no working directory, and reading a true cwd needs
 * handle inspection this script deliberately does not attempt. So a process
 * whose cwd is the worktree and whose argv names it nowhere — a bare
 * `node vitest run`, an editor holding files open, an 8.3 short path — is
 * invisible here.
 *
 * That gap is survivable only because it is not the last line of defence.
 * Removal uses `git worktree remove` WITHOUT `--force`, and git independently
 * refuses to delete a tree containing modified or untracked files. A crew
 * actively working has, essentially always, written something. Treat this
 * function as the cheap early filter and git's own refusal as the guarantee —
 * which is why that call must never gain `--force`.
 */
function hasLiveProcess(snapshot, worktreePath) {
  const forward = worktreePath.toLowerCase().replace(/\\/g, "/");
  const backward = forward.replace(/\//g, "\\");
  if (snapshot.includes(forward) || snapshot.includes(backward)) return true;
  const basename = forward.slice(forward.lastIndexOf("/") + 1);
  // Guard against a pathologically short or empty basename matching everything.
  return basename.length >= 4 && snapshot.includes(basename);
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

/**
 * Every branch that has a pull request, mapped to that PR's state.
 *
 * ── Why this signal is needed at all ────────────────────────────────────
 *
 * `filesStillDiffering` recognises a squash merge only while the files that
 * branch touched are untouched on the base branch afterwards. On a repo
 * moving at 50+ PRs in a few days that window closes almost immediately, so
 * the check degrades from "is this merged?" to "was this merged recently?".
 *
 * Measured on 2026-08-25: of 70 worktrees, the PR record says 55 were
 * merged; ancestry recognised 4 and the content comparison 21. The failure
 * is not random, it is systematically biased toward "do not delete", which
 * is the safe direction but leaves the leak in place.
 *
 * `fix/app-shell-sentinel-binary` is the worked example. Its work is on the
 * base branch as `a1fe032` (#203) — genuinely, provably merged — yet one
 * file still differs because three later PRs (#213, #268, #270) edited that
 * same file. Nothing about the branch changed; the base branch moved.
 *
 * ── Why asking GitHub is safe here ─────────────────────────────────────
 *
 * This is one `gh` call for the whole repository, not one per branch.
 *
 * More importantly it can only ever ADD merged-ness. A branch this map
 * reports as MERGED is removable; a branch it says nothing about falls back
 * to the content comparison exactly as before. So when `gh` is missing,
 * unauthenticated or rate-limited we return an empty map and the sweep
 * removes strictly LESS than it otherwise would — never more. "Could not
 * ask" must not be able to widen what gets deleted.
 *
 * Only `MERGED` counts. `CLOSED` deliberately does NOT: a closed-unmerged
 * PR is a person deciding not to take that work, which makes the worktree
 * possibly the only copy of it — the opposite of safe to delete.
 */
function pullRequestStates() {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "400", "--json", "headRefName,state"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch {
    return { states: new Map(), available: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { states: new Map(), available: false };
  }
  return { states: reducePullRequestStates(parsed), available: true };
}

/**
 * Collapses the PR list to one state per branch.
 *
 * A branch can carry several pull requests — reopened, superseded, or simply
 * reused after a merge. `MERGED` wins over everything else, because once any
 * PR from a branch has merged, that work is on the base branch regardless of
 * what happened to the others.
 */
function reducePullRequestStates(pullRequests) {
  const states = new Map();
  for (const pr of pullRequests) {
    if (!pr?.headRefName) continue;
    if (states.get(pr.headRefName) === "MERGED") continue;
    states.set(pr.headRefName, pr.state);
  }
  return states;
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

  const { states: prStates, available: prsAvailable } = pullRequestStates();

  console.log(`base ${base} = ${baseSha}`);
  console.log(
    prsAvailable
      ? `pull requests: ${prStates.size} branches known to GitHub`
      : "pull requests: UNAVAILABLE (gh missing, unauthenticated or rate-limited) — " +
          "falling back to the content comparison, which removes strictly less",
  );
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
    // Two independent ways for the work to be safely on the base branch. The
    // PR record is checked first because it stays true as the base branch
    // moves on, whereas the content comparison silently stops recognising a
    // merge once anything else edits the same files.
    const prState = wt.branch ? prStates.get(wt.branch) : undefined;
    let mergedBecause = null;

    // A closed-unmerged PR is a person deciding not to take that work, so the
    // worktree may hold the only copy. That decision outranks both merge
    // signals: refuse before either is consulted, rather than letting an
    // incidental content match delete it.
    if (prState === "CLOSED") {
      kept.push([
        label,
        "its pull request was CLOSED without merging — this may be the only copy of that work",
      ]);
      continue;
    }

    if (prState === "MERGED") {
      mergedBecause = "its pull request is merged";
    } else {
      const differing = filesStillDiffering(mainCheckout, head, baseSha);
      if (differing === null) {
        kept.push([label, `no merge-base with ${base} — cannot tell if its work is safe`]);
        continue;
      }
      if (differing > 0) {
        // Say which signal was consulted, so "kept" is never mistaken for
        // "GitHub said it was unmerged" when GitHub was never reachable.
        const why = prsAvailable
          ? `${differing} file(s) differ from ${base}, and no merged pull request — work is not on the base branch`
          : `${differing} file(s) differ from ${base} — work is not on the base branch (pull request state was unavailable)`;
        kept.push([label, why]);
        continue;
      }
      mergedBecause = `content is present on ${base}`;
    }

    if (!apply) {
      removed.push([label, `would remove: clean, no live process, ${mergedBecause}`]);
      continue;
    }

    // Re-check cleanliness one final time, immediately before the removal
    // itself. Everything above is still a snapshot the moment it is read.
    const finalStatus = git(["status", "--porcelain"], wt.path);
    if (finalStatus === null || finalStatus.split("\n").filter(Boolean).length > 0) {
      kept.push([label, "became dirty between the check and the removal"]);
      continue;
    }
    // NEVER add `--force` here. Without it git independently refuses to
    // delete a worktree containing modified or untracked files, which is the
    // last and strongest guard in this script: it closes the residual race
    // between the check above and this call, and it is the only guard that
    // still holds when `hasLiveProcess` misses a crew it cannot see.
    // Adding `--force` for convenience would silently remove that layer.
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

// Run only when invoked directly, so the guards above can be imported and
// tested without the sweep executing as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { hasLiveProcess, looksLikeProcessList, reducePullRequestStates };
