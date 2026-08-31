// Recognising what a command is *trying* to do — MILESTONES.md #128.
//
// This module answers "what shape is this command?" and nothing else. It
// never decides whether the command is allowed: that is a predicate's job,
// and the whole point of the split is that the condition lives in server
// state which a string cannot carry. `docs/plans/INTERVENTIONS.md` states
// the thesis for I10 — *"the server decides, the client only recognises
// that a merge is being attempted"* — and this is the recognising half,
// sitting server-side because that is simply where the command text
// arrives, not because recognition needs anything from here.
//
// ── Why recognition is deliberately narrow ─────────────────────────────
//
// Every function here is written to under-match rather than over-match. A
// shape this module fails to recognise produces no finding, and a missed
// finding costs one un-nudged call; a shape it wrongly recognises produces
// a block on a command that was fine, which costs a session its work and
// teaches it to distrust the guard. Those are not symmetric, and the
// asymmetry decides every judgement call below.
//
// `../kill/parse.ts` already reads kill commands properly — targets, verbs,
// shell wrappers, the unparseable case — so I12 reuses it rather than
// growing a second, worse kill parser here. What this module adds is only
// the shapes nothing else already reads.

import { parseKillCommand, splitStatements } from "@/lib/kill/parse";

/**
 * Whether a statement invokes git with the given subcommand.
 *
 * Takes the subcommand rather than being written once per verb because the
 * awkward part is identical for all of them: git accepts global options
 * before the subcommand (`git -C /path merge`, `git --no-pager log`), so
 * the subcommand is not reliably the second token. This skips leading
 * `-`-prefixed options and the one option that takes a value (`-C`), then
 * compares the first token that is left.
 *
 * Deliberately does not attempt aliases. `git mg` may be `merge` on one
 * machine and nothing on another, and a guard that guessed would be wrong
 * in an unpredictable direction on a machine nobody is looking at.
 */
export function invokesGitSubcommand(statement: string, subcommand: string): boolean {
  const tokens = statement.trim().split(/\s+/);
  const gitAt = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
  if (gitAt === -1) return false;
  // Anything before `git` means git is not the verb of this statement — it
  // is an argument to something else (`echo git merge`, `grep git`), and
  // that is not a merge attempt.
  if (gitAt !== 0) return false;

  let index = gitAt + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) return false;
    // `-C <path>` and `-c <name>=<value>` take a separate value token.
    if (token === "-C" || token === "-c") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return token === subcommand;
  }
  return false;
}

/**
 * Whether a command would merge or fast-forward something into the branch
 * that is checked out — I10's recognition half.
 *
 * Three shapes count, and the third is the one that gets forgotten:
 *
 *   - `git merge <ref>` — the obvious one.
 *   - `git pull` — a fetch and a merge, so it lands other people's commits
 *     on the checked-out branch exactly as `git merge` does.
 *   - `gh pr merge` — merges *on the server*, which is the shape that
 *     actually lands work on the default branch in this repository. A check
 *     that only read `git merge` would watch the door nobody uses.
 *
 * Explicitly NOT counted: `git merge --abort`, `--continue` and `--quit`,
 * which end a merge rather than starting one, and `git merge-base` /
 * `git merge-tree`, which compute and write nothing. Each is a distinct
 * token, so each is excluded by name rather than by a pattern that might
 * one day exclude something else.
 */
export function isMergeAttempt(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (invokesGitSubcommand(trimmed, "merge")) {
      // These finish or discard a merge already in progress. None of them
      // introduces a commit that has not been reviewed, so blocking them
      // would refuse the cleanup after a block rather than the merge.
      if (/\s--(abort|continue|quit)\b/.test(trimmed)) return false;
      return true;
    }

    if (invokesGitSubcommand(trimmed, "pull")) return true;

    // `gh pr merge`. Matched on the pair rather than on `gh` alone, so
    // `gh pr view` and `gh pr checks` — the two things a session watching
    // its own PR runs constantly — are not merge attempts.
    if (/^gh\s+(?:[^\s;&|]+\s+)*?pr\s+merge\b/.test(trimmed)) return true;

    return false;
  });
}

/**
 * Whether a command would end processes without naming which ones — I12's
 * recognition half.
 *
 * **Deliberately not an ownership check.** `INTERVENTIONS.md` settles this
 * explicitly: the point is to make the caller pause and ask whether a
 * narrower kill would do, which is the answer most of the time. An
 * ownership route needs a live process registry, correct PID attribution
 * and an accurate crew root — machinery whose failure mode is *silently
 * wrong in both directions*, refusing work that was fine or waving through
 * the exact kill it exists to stop. `kill_guard` remains available as a
 * service call for anything that later wants the precise answer.
 *
 * So the question here is only *breadth*: a kill that names process ids is
 * scoped and passes; a kill that names an executable, or one this build
 * cannot decompose at all, is broad and is the subject of the entry.
 *
 * Reuses `../kill/parse.ts` rather than growing a second kill parser. That
 * module already reads the verbs, the shell wrappers and the by-filter
 * forms, and — critically — already distinguishes `unparseable` from
 * `not-a-kill`, which is the distinction this depends on. A kill-shaped
 * command whose targets cannot be read is broad by the only honest
 * reading: an unread selector is not an empty one.
 */
export function isBroadProcessKill(command: string): boolean {
  const parsed = parseKillCommand(command);

  if (parsed.kind === "not-a-kill") return false;
  // Kill-shaped and undecomposable. Treated as broad for the same reason
  // `kill_guard` denies on it: the command ends processes and this build
  // cannot say which, so "narrow" is not something anyone can assert.
  if (parsed.kind === "unparseable") return true;

  // A kill naming no target at all is not a kill of everything — it is a
  // malformed command the shell will reject — so it is not this entry's
  // business.
  if (parsed.targets.length === 0) return false;

  // Broad exactly when it names an image rather than a process. `taskkill
  // /IM node.exe` and `pkill node` take out every sibling agent's
  // processes, and the caller has no way to tell from the command that it
  // did. A list of pids is scoped however long it is.
  return parsed.targets.some((target) => target.kind === "executable");
}

/**
 * Whether a command records work permanently — I13's recognition half.
 *
 * Two shapes, and both are deliberate:
 *
 *   - `git commit` — the moment work stops being scratch and becomes
 *     something with a sha that a board row would want to point at.
 *   - `git push` — the moment it leaves the machine. Counted separately
 *     because a session can commit locally for a while quite reasonably and
 *     only later decide the work is real; a push is the point where that
 *     question has been answered.
 *
 * Explicitly NOT counted: `git commit --amend` and `--dry-run`. An amend
 * rewrites a commit that already exists, so if the work was unminted the
 * nudge was already due at the original commit and repeating it at every
 * amend is how a guard becomes noise. A dry run writes nothing at all.
 *
 * Under-matches by construction, like everything else here: `gh pr create`
 * is not included even though it plainly records work, because its absence
 * costs one un-nudged call while a wrong match costs a spurious nudge on
 * the busiest verb a builder runs.
 */
export function isWorkRecordingCommand(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (invokesGitSubcommand(trimmed, "commit")) {
      // An amend rewrites a commit that already exists and a dry run writes
      // nothing. Neither is the moment work first becomes permanent.
      if (/\s--(amend|dry-run)\b/.test(trimmed)) return false;
      return true;
    }

    if (invokesGitSubcommand(trimmed, "push")) {
      if (/\s--dry-run\b/.test(trimmed)) return false;
      return true;
    }

    return false;
  });
}

/**
 * Whether a command is trying to establish that a branch was merged by
 * comparing commit refs — the recognition half of the squash-merge nudge.
 *
 * The situation is specific and the failure is silent, which is what makes
 * it worth a nudge rather than a doc line. This project squash-merges, so a
 * merged branch's commits **do not appear on the target branch at all**:
 * the squash produces one new commit with a new sha, and the branch's own
 * commits are never ancestors of it. Every ref-comparison answers "not
 * merged" — truthfully, for the question it was asked, and misleadingly for
 * the question the caller meant.
 *
 * The shapes recognised are the ones that ask "is X an ancestor of Y" or
 * "what is on X that is not on Y":
 *
 *   - `git branch --merged` / `--no-merged` — ancestry by another name.
 *   - `git merge-base --is-ancestor` — the explicit form.
 *   - `git cherry`, `git log main..branch`, `git rev-list main..branch` —
 *     the "what is not yet there" forms, which read as empty-or-not.
 *
 * Deliberately NOT recognised: `git log --oneline` with no range, `git
 * diff`, or a bare `git branch`. Those are ordinary reads a session runs
 * constantly, and nudging on them would be a nudge on nearly every call —
 * the "fires and annoys" failure that earns an entry a 1 on the owner's own
 * scale.
 */
export function isMergedByRefComparison(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    // `git branch --merged` / `--no-merged` — ancestry, asked as a listing.
    if (invokesGitSubcommand(trimmed, "branch") && /\s--(no-)?merged\b/.test(trimmed)) return true;

    // The explicit ancestry test. `git merge-base` alone computes a
    // reference point and is not a merged-or-not question.
    if (invokesGitSubcommand(trimmed, "merge-base") && /\s--is-ancestor\b/.test(trimmed)) {
      return true;
    }

    // `git cherry` exists to answer "which of these commits are upstream",
    // which is precisely the question squash-merging invalidates.
    if (invokesGitSubcommand(trimmed, "cherry")) return true;

    // A two-dot range on log or rev-list: "what is on one and not the
    // other". Required to carry a range, so an ordinary `git log` is not
    // matched. The range is anchored to a token so a filename containing
    // two dots is not mistaken for one.
    if (invokesGitSubcommand(trimmed, "log") || invokesGitSubcommand(trimmed, "rev-list")) {
      return /(^|\s)[^\s.]+\.\.[^\s.]+(\s|$)/.test(trimmed);
    }

    return false;
  });
}

/**
 * Whether a command is a rebase, or is checking whether a branch has
 * diverged from its base — the recognition half of the rebase-restraint
 * nudge.
 *
 * Both halves are one shape for one reason: the check is almost always the
 * prelude to the rebase, and the advice is the same at either point. Catching
 * only the rebase itself would arrive after the caller had already spent the
 * calls deciding to do it.
 *
 * Recognised: `git rebase` (but not `--abort`, `--continue`, `--skip`, which
 * end one already in progress), `git pull --rebase`, and the
 * "would this merge" probes — `git merge --no-commit --no-ff` and
 * `git merge-tree`, which exist to test a merge without performing one.
 *
 * `git fetch` and `git status` are deliberately absent: they are what every
 * session runs to orient itself, and reading them as rebase intent would
 * nudge constantly on the most ordinary commands there are.
 */
export function isRebaseOrDivergenceCheck(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (invokesGitSubcommand(trimmed, "rebase")) {
      // Finishing or abandoning a rebase already under way. The decision
      // this nudge speaks to was made some time ago; repeating it here
      // would nudge hardest at the caller who is already cleaning up.
      if (/\s--(abort|continue|skip|quit)\b/.test(trimmed)) return false;
      return true;
    }

    if (invokesGitSubcommand(trimmed, "pull") && /\s--rebase\b/.test(trimmed)) return true;

    // A trial merge: performed to see whether it would conflict, then
    // thrown away. `merge-tree` writes nothing at all and is the purest
    // form of the question.
    if (invokesGitSubcommand(trimmed, "merge-tree")) return true;
    if (
      invokesGitSubcommand(trimmed, "merge") &&
      /\s--no-commit\b/.test(trimmed) &&
      /\s--no-ff\b/.test(trimmed)
    ) {
      return true;
    }

    return false;
  });
}
