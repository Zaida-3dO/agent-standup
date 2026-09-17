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
 * Whether a statement constrains git to a fast-forward, so it cannot create
 * a merge commit.
 *
 * **Reads the flags in order, and lets the last one win**, because that is
 * what git itself does: `--no-ff` after `--ff-only` leaves the command able
 * to build a real merge, and a check that simply asked "does `--ff-only`
 * appear anywhere" would wave exactly that through. This is the widening
 * mistake worth guarding against, so it is written as a fold over the flags
 * rather than as a `.includes`.
 *
 * `--ff` is not treated as re-permitting anything: it is git's default
 * (fast-forward *when possible*, merge otherwise), so it leaves the command
 * able to merge and therefore leaves the answer `false`.
 *
 * Under-matches like everything else in this module — an unrecognised flag
 * spelling produces `false`, which means the command stays *recognised* as a
 * merge attempt. A missed exclusion costs one spurious block; a wrong
 * exclusion lets an unreviewed merge through, and those are not symmetric.
 */
export function allowsOnlyFastForward(statement: string): boolean {
  let fastForwardOnly = false;
  for (const token of statement.trim().split(/\s+/)) {
    if (token === "--ff-only") fastForwardOnly = true;
    // Both re-permit a merge commit: `--no-ff` forces one, and `--ff` is
    // merely git's default, which falls back to a merge when the update is
    // not a fast-forward.
    else if (token === "--no-ff" || token === "--ff") fastForwardOnly = false;
  }
  return fastForwardOnly;
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
 *
 * ── `--ff-only`, and why it is not a merge ──────────────────────────────
 *
 * Row f296b059-e867-456f-af2a-d11af92a34c4. `git pull --ff-only` was read
 * as a merge, and it is the command every session runs to catch up before
 * it starts work — so the one false positive here was met constantly, and
 * its message ("no approving review at its current tip commit") sent the
 * reader to look at reviews, which is the wrong place. The session that
 * isolated it spent six attempts and five wrong theories, and only found it
 * by accident, when a command that merely returned to the trunk and updated
 * it produced the identical refusal.
 *
 * `--ff-only` is excluded because of what git does with it, not because it
 * is common: git **refuses and exits non-zero** unless the update is a
 * fast-forward. A fast-forward moves the branch pointer to a commit that
 * already has the current tip as an ancestor — it writes no merge commit
 * and it introduces no history that was not already on the remote. There is
 * nothing for a review-at-tip check to be protecting.
 *
 * The narrowing is exactly that flag, on `pull` and on `merge` alike. A
 * bare `git pull` still counts: without `--ff-only` git will happily build
 * a merge commit out of divergent history, which is precisely the unapproved
 * merge this entry exists to catch. So does `git pull --ff-only --no-ff`
 * and any other combination that re-permits a true merge — see
 * `allowsOnlyFastForward`.
 */
export function isMergeAttempt(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (invokesGitSubcommand(trimmed, "merge")) {
      // These finish or discard a merge already in progress. None of them
      // introduces a commit that has not been reviewed, so blocking them
      // would refuse the cleanup after a block rather than the merge.
      if (/\s--(abort|continue|quit)\b/.test(trimmed)) return false;
      // Constrained to a fast-forward, so it can only advance the pointer to
      // a descendant — it cannot write a merge commit, and git aborts rather
      // than merging if the update is not a fast-forward.
      if (allowsOnlyFastForward(trimmed)) return false;
      return true;
    }

    if (invokesGitSubcommand(trimmed, "pull")) {
      // The false positive from row f296b059: catching up a tracking branch
      // to a remote it already agrees with introduces no unreviewed work.
      // A bare `git pull` still counts — see this function's header.
      if (allowsOnlyFastForward(trimmed)) return false;
      return true;
    }

    // `gh pr merge`. Matched on the pair rather than on `gh` alone, so
    // `gh pr view` and `gh pr checks` — the two things a session watching
    // its own PR runs constantly — are not merge attempts.
    if (/^gh\s+(?:[^\s;&|]+\s+)*?pr\s+merge\b/.test(trimmed)) return true;

    return false;
  });
}

/**
 * Whether a command is *landing* work — the closing moment of a row, as
 * opposed to merely writing a merge commit. I28's recognition half.
 *
 * ── Why this is not just `isMergeAttempt` ───────────────────────────────
 *
 * The two ask different questions, and reusing one for the other would be
 * wrong in a way that costs load rather than correctness.
 *
 * `isMergeAttempt` answers *"could this introduce history that no review
 * has seen?"*, for the approval limb. A bare `git pull` genuinely can —
 * git will build a merge commit out of divergent history — so catching it
 * there is right, and this function deliberately does not disturb that.
 *
 * This one answers *"is a row closing right now?"*, for the delivery limb.
 * I28 (`nits-merged-with-nothing-tracking-them`) picks `immediate` timing
 * precisely because it "describes a row that is CLOSING", and the same
 * reasoning decides what counts: `git merge` and `gh pr merge` land the
 * work, and are the moment outstanding findings stop being visible.
 *
 * ── `git pull` is excluded, and that is the whole point ─────────────────
 *
 * `git pull` is the opposite event. It catches a branch *up* at the start
 * or the middle of work; nothing closes, and no finding can become
 * invisible because of it. So including it would buy exactly zero
 * additional findings — while putting the assignment and artifact lookups
 * behind the single highest-frequency git command a session runs.
 *
 * That is the cost the `delivery` gate exists to avoid: its own comment in
 * `context.ts` says what it excludes is the "ordinary read traffic that can
 * never be the subject of any of them", and the zero-query suite in
 * `hook-decision-operation.test.ts` pins it. A pull is that traffic.
 *
 * Row f296b059 is the standing warning here. `git pull --ff-only` was once
 * read as a merge, and because it is what every session runs before it
 * starts work, the false positive was met constantly and sent six attempts
 * chasing the wrong explanation. Widening a gate onto `pull` is a mistake
 * this module has already paid for once.
 *
 * `--ff-only` is excluded for `merge` for the same reason `isMergeAttempt`
 * excludes it: git refuses unless the update is a fast-forward, so it moves
 * a pointer and lands nothing that was not already on the remote. The
 * `--abort`/`--continue`/`--quit` forms end a merge rather than landing
 * one, and are excluded by name.
 */
export function isMergeLanding(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (invokesGitSubcommand(trimmed, "merge")) {
      if (/\s--(abort|continue|quit)\b/.test(trimmed)) return false;
      if (allowsOnlyFastForward(trimmed)) return false;
      return true;
    }

    // Matched on the subcommand pair rather than on `gh` alone, so the
    // `gh pr view` / `gh pr checks` a session runs while watching its own
    // PR stay off the query path.
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
 * Whether a command is a recursive content search with nothing narrowing it
 * — I16's nudge-level half.
 *
 * ── What this can and cannot know ──────────────────────────────────────
 *
 * The catalogued I16 is `block-overridable` and needs *"the size of the
 * directory a search is rooted at"*, which the server cannot see: the hook
 * carries no scope or size field, so a block would be refusing work on a
 * guess. That half stays unbuilt and its entry stays on the record.
 *
 * The owner's narrower ask needs none of it — *"can you at least nudge on
 * any search to bias to try ls or quicker ways to navigate instead"* — so
 * this is a pure command-shape test, the cheapest kind in the catalogue and
 * the same kind `isBroadGitAdd` and `isBroadProcessKill` already are.
 *
 * ── What counts as unscoped, which is the whole design ─────────────────
 *
 * The finding is not "searching is wrong". It is reaching for a recursive
 * content search where listing the directory first would have answered the
 * question. So a search the caller has already narrowed must NOT fire, or
 * the entry becomes noise on one of the most common commands there is.
 *
 * **Matched:** a bare recursive content search — `grep -r pattern`,
 * `rg pattern`, `ag pattern` — with no path argument, or rooted at `.` or
 * `/`, and no filter narrowing it.
 *
 * **Deliberately exempt, each because the caller is already being specific:**
 *
 *   - **A path argument** beyond `.` or `/` — `rg pattern src/lib` is a
 *     scoped search and is the behaviour this entry is steering toward.
 *   - **A glob or a type filter** — `--include`, `-g`, `--glob`, `-t`,
 *     `--type`. These bound the walk, which is the expensive part.
 *   - **A file list or a pipe** — `grep pattern file.ts`, or anything
 *     reading stdin, where there is no directory walk at all.
 *   - **`-l`/`--files-with-matches` is NOT exempt**, because it bounds the
 *     output rather than the walk, and the walk is what costs the turn.
 *
 * Under-matching is the safe direction and is chosen deliberately: a missed
 * match costs one un-nudged search, while a false match puts a message on a
 * correctly-scoped command — and this entry fires on common traffic, so it
 * is the one most likely to be judged noise if it gets that wrong.
 */
export function isUnscopedRecursiveSearch(command: string): boolean {
  // **Pipelines are rejected before splitting, not after.** `splitStatements`
  // treats `|` as a separator, so by the time a statement is in hand the pipe
  // is gone and every stage looks like a standalone command — which reports
  // `cat x | grep -r TODO` as an unscoped search of the whole tree. A test
  // pins exactly that case.
  if (/\|/.test(command)) return false;

  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    // `grep` walks a tree only when told to; `rg` and `ag` do by default.
    // The recursion flag is matched anywhere inside a short-flag cluster, so
    // `-rn` and `-nr` both count — `\b` after `[rR]` fails on `-rn`, because
    // there is no word boundary between two letters.
    const isRecursiveGrep =
      /(^|[;&]\s*)grep\b/.test(trimmed) && /\s-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)/.test(trimmed);
    const isRipgrepLike = /(^|[;&]\s*)(rg|ag|ack)\b/.test(trimmed);
    if (!isRecursiveGrep && !isRipgrepLike) return false;

    // Any filter that bounds the walk means the caller has already narrowed
    // it, which is the behaviour this entry exists to encourage.
    if (/\s(--include|--exclude|-g|--glob|--type|--type-not|-t)(\s|=)/.test(trimmed)) return false;

    // A path argument beyond the root. Flags and their values are dropped,
    // then the pattern, and whatever is left is a path the caller supplied.
    const words = trimmed.split(/\s+/).slice(1);
    const operands = words.filter((word) => !word.startsWith("-"));
    // The first operand is the pattern; anything after it is a path.
    const paths = operands.slice(1);
    if (paths.some((path) => path !== "." && path !== "./" && path !== "/")) return false;

    return true;
  });
}

/**
 * Whether a command starts a wait on this session's crew — the stop catch's
 * "a wake is already scheduled" half.
 *
 * ── Why a command shape and not a stored flag ──────────────────────────
 *
 * Nothing records "a wait is running". `wait_for_crew` is a read operation
 * that blocks and returns; it writes no in-progress row, and giving it one
 * would mean a write on a read path plus a way to clear it when the shell
 * process dies — durability machinery for a fact that is minutes old. What
 * a backgrounded wait does leave is the `Bash` call that launched it, and
 * recognising that call is the honest form of the inference.
 *
 * ── Why the `tool` column cannot answer this ───────────────────────────
 *
 * Worth stating because it is the obvious first guess and it is wrong.
 * `ToolCall.tool` holds the *harness's* tool name — `Bash`, `Read`, `Edit`
 * (`../telemetry/shape.ts`) — never an operation name, because the rows are
 * written from hook telemetry about the agent's own calls. `standup crew
 * wait` is a shell invocation, so it arrives as `Bash` with the text in
 * `command`, and a query keyed on `tool = 'wait_for_crew'` would match
 * nothing at all while looking entirely reasonable.
 *
 * ── What it matches, and which way it errs ─────────────────────────────
 *
 * The `crew wait` verb pair on a `standup` invocation, however the binary is
 * spelled — a bare `standup`, a path to it, `npx standup`. The trailing
 * flags are not inspected: `--since` is required by the command itself, and
 * a wait is a wait whatever cursor it starts from.
 *
 * Under-matching is the safe direction and is chosen deliberately. A missed
 * match means the catch speaks to an orchestrator that had in fact
 * backgrounded a wait — one unnecessary line. A false match means the catch
 * stays silent for a session with crew running and nothing coming back for
 * them, which is the whole situation it exists to catch. So this recognises
 * the documented invocation rather than trying to guess at every wrapper.
 */
export function isCrewWaitCommand(command: string): boolean {
  return splitStatements(command).some((statement) =>
    // `standup` as a whole word, then `crew` then `wait` as the next two
    // words. Anchored on a word boundary rather than the start of the
    // statement so a backgrounded invocation with an env prefix or a path
    // still matches, and separated by `\s+` so the verb pair cannot be
    // matched across an unrelated argument.
    /\bstandup\b[^\n;]*?\bcrew\s+wait\b/.test(statement.trim()),
  );
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

/**
 * Whether a command opens a pull request — the fourth shape that advances
 * an item's delivery stage, and the one git has no subcommand for.
 *
 * Used only as a **gate** on context assembly (`./context.ts`), never as a
 * predicate's own signal. That distinction is what keeps it cheap to be
 * wrong: the entries it serves key on artifact rows, so a command this
 * misses costs at most a nudge deferred to the next call that does match,
 * and one it over-matches costs a single query on a call that was going to
 * be allowed regardless. Neither is a wrong answer to a caller.
 *
 * Deliberately narrow. `gh pr create` is the shape in use here; `gh pr
 * view`, `gh pr list` and `gh pr checks` are ordinary reads a session runs
 * constantly and must stay off the query path, so the subcommand pair is
 * matched rather than the tool name alone.
 */
export function isPullRequestOpen(command: string): boolean {
  return splitStatements(command).some((statement) =>
    // **Anchored at the start of the statement, not merely at a word
    // boundary.** The first version of this allowed any preceding
    // whitespace, which matched the phrase wherever it appeared — so
    // `echo gh pr create` was read as opening a pull request. A negative
    // control in `tests/interventions-delivery.test.ts` caught it, which is
    // the argument for writing the negative half first: the positive cases
    // all passed against the broken matcher.
    //
    // The same reasoning `invokesGitSubcommand` applies to git: a command
    // is what a statement *starts* with, and a statement is already split
    // on `&&`, `;` and `|` before it reaches here, so anchoring costs
    // nothing a real caller would notice.
    /^gh\s+pr\s+create(\s|$)/.test(statement.trim()),
  );
}

/**
 * Whether a command goes out of its way to suppress commit signing — I17's
 * recognition half.
 *
 * **The default is deliberately not the finding, and that is the whole
 * shape of this check.** A plain `git commit` signs when signing is
 * configured and does not when it is not, and either way that is the
 * operator's standing choice rather than a decision made by this call. What
 * is worth noticing is a command that *overrides* that choice inline — the
 * same shape as `isBroadGitAdd`, which is also "a flag that opts out of a
 * safe default" rather than a command that is wrong in itself.
 *
 * This is why the entry reading it is a nudge and not a block. The
 * suppression is frequently legitimate — a fixup on a machine with no key,
 * a scripted commit, a rebase of someone else's commits — so the honest
 * response is to say the signature will be missing and let the caller
 * proceed, not to refuse a command that may be exactly right.
 *
 * Two spellings count, and they are not the same mechanism:
 *
 *   - `--no-gpg-sign` — the flag on `commit`, `merge`, `rebase`, `cherry-pick`
 *     and `revert`, each of which can create a commit.
 *   - `-c commit.gpgsign=false` (or `-c tag.gpgsign=false`) — a one-call
 *     config override, which `invokesGitSubcommand` deliberately skips past
 *     when finding the subcommand. So the tokens are scanned here directly
 *     rather than through that helper, which would never see them.
 *
 * ── What is deliberately NOT recognised ─────────────────────────────────
 *
 * `--gpg-sign` / `-S` and `-c commit.gpgsign=true` are the opposite
 * intent and must never fire. Nor does a bare `git commit`: reading the
 * absence of a flag as suppression would nudge on every commit in the
 * system, which is the nudge-fatigue failure the catalogue scores a 1.
 *
 * `git config --global commit.gpgsign false` is also not matched. It
 * changes the machine's standing configuration rather than suppressing
 * signing on a commit being made now — a different act, addressed to a
 * different decision, and one this entry has nothing useful to say about.
 *
 * Under-matches like everything else in this module: an unrecognised
 * spelling produces `false` and costs one un-nudged call.
 */
/**
 * Whether a statement invokes a git verb that can create a commit.
 *
 * Shared by the two signing recognisers rather than written out in each,
 * because they are the *same* question asked about opposite flags, and two
 * copies of the verb list would drift the moment one of them learned about
 * a verb the other did not. `git log --gpg-sign` is not a thing, but scoping
 * by verb means a future flag of either spelling on a read command cannot
 * fire either entry.
 */
/**
 * The index of the last token belonging to one argument, starting at `from`.
 *
 * Whitespace-splitting a statement tears a quoted argument into pieces, so
 * "the value of `-m`" is not reliably one token: `-m 'add -S support'`
 * arrives as `'add`, `-S`, `support'`. This walks to the closing quote so a
 * caller can skip the whole run rather than a single piece of it.
 *
 * Deliberately crude, and biased the same way as everything else here. It
 * handles the two quote characters a shell uses and does not attempt
 * escapes, nested quotes or `$(…)`. An **unterminated** quote consumes the
 * rest of the statement, which is the safe direction for this caller: the
 * result is that a flag after an unbalanced quote goes unrecognised — one
 * un-nudged call — rather than prose being read as a flag, which is a false
 * nudge on a command that was fine.
 */
function endOfArgument(tokens: readonly string[], from: number): number {
  const first = tokens[from];
  if (first === undefined) return from;
  const quote = first.startsWith("'") ? "'" : first.startsWith('"') ? '"' : null;
  // An unquoted value is exactly one token.
  if (quote === null) return from;
  // A single token carrying both quotes — `-m 'x'` — is already complete.
  if (first.length > 1 && first.endsWith(quote)) return from;
  for (let index = from + 1; index < tokens.length; index += 1) {
    if (tokens[index]?.endsWith(quote) === true) return index;
  }
  return tokens.length - 1;
}

function createsCommit(statement: string): boolean {
  return ["commit", "merge", "rebase", "cherry-pick", "revert", "am"].some((verb) =>
    invokesGitSubcommand(statement, verb),
  );
}

export function suppressesCommitSigning(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (!createsCommit(trimmed)) return false;

    const tokens = trimmed.split(/\s+/);

    // The explicit flag.
    if (tokens.includes("--no-gpg-sign")) return true;

    // The inline config override. Matched as a `-c` and its value together,
    // so that a literal `commit.gpgsign=false` appearing as an argument to
    // something else — in a commit message, say — is not read as one.
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== "-c") continue;
      const setting = tokens[index + 1];
      if (setting === undefined) continue;
      if (/^(commit|tag)\.gpgsign=(false|no|off|0)$/i.test(setting)) return true;
    }

    return false;
  });
}

/**
 * Whether a command goes out of its way to *force* commit signing — the
 * mirror of `suppressesCommitSigning`.
 *
 * **Same shape, opposite flag, and the reasoning is symmetrical.** A plain
 * `git commit` signs when signing is configured and does not when it is not.
 * That is the operator's standing choice, expressed once in configuration,
 * and it is the answer for every commit the repository will ever receive. A
 * command carrying `-S` is overriding that choice inline for this one
 * commit — the same "a flag that opts out of a safe default" shape
 * `isBroadGitAdd` and `suppressesCommitSigning` both recognise, rather than
 * a command that is wrong in itself.
 *
 * ── Why this is worth a nudge at all, given signing is the good outcome ──
 *
 * The suppression entry is easy to justify: an unsigned commit in a repo
 * that signs is a visible defect. Forcing a signature looks like the
 * virtuous direction, which is exactly why it is worth saying something
 * about — the failure it produces is not a bad commit but a **failed
 * command**, and one whose error text sends the reader in the wrong
 * direction. On a machine with no key, `git commit -S` aborts with a
 * gpg error and no commit is made at all; the work is still there, the
 * agent reads a signing failure as a broken environment, and the remedy it
 * reaches for is usually to configure something rather than to drop a flag
 * it did not need. An installation that signs would have signed anyway.
 *
 * So it is a **nudge**, for the same reason its mirror is one: forcing a
 * signature is frequently legitimate — a repository that does not sign by
 * default, a release commit held to a higher bar, a machine whose global
 * config is wrong — and refusing it would refuse a command that may be
 * exactly right.
 *
 * Two spellings count, and they are the mirrors of the two the suppression
 * check recognises:
 *
 *   - `-S` and `--gpg-sign` — the flag on `commit`, `merge`, `rebase`,
 *     `cherry-pick` and `revert`, each of which can create a commit.
 *   - `-c commit.gpgsign=true` — a one-call config override, which
 *     `invokesGitSubcommand` deliberately skips past when finding the
 *     subcommand, so the tokens are scanned here directly.
 *
 * ── What is deliberately NOT recognised ─────────────────────────────────
 *
 * `--no-gpg-sign` and `-c commit.gpgsign=false` are the opposite intent and
 * belong to `suppressesCommitSigning`; matching them here would fire both
 * entries on one command. Nor does a bare `git commit`: reading the absence
 * of a flag as forcing would nudge on every commit in the system, which is
 * the nudge-fatigue failure the catalogue scores a 1.
 *
 * **`-S` is matched as its own token only**, which is the one place this
 * check is materially harder than its mirror. `--no-gpg-sign` is
 * unambiguous, while `-S` is a single letter that appears as a value
 * (`git commit -m -S`), inside a bundle, and as an entirely different
 * option on other commands. Scanning for the bare token — rather than a
 * substring — is what keeps `git commit -m "add -S support"` off it, and
 * the tokens after `-m` are skipped for the same reason. Bundled forms like
 * `-Sm` are **not** matched: under-matching costs one un-nudged call, and
 * over-matching costs a false nudge on a legitimate command, which is the
 * direction this whole module biases away from.
 *
 * `git config --global commit.gpgsign true` is also not matched, mirroring
 * its opposite: it changes the machine's standing configuration rather than
 * signing a commit being made now.
 */
export function forcesCommitSigning(command: string): boolean {
  return splitStatements(command).some((statement) => {
    const trimmed = statement.trim();

    if (!createsCommit(trimmed)) return false;

    const tokens = trimmed.split(/\s+/);

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined) continue;

      // A message's text is not a flag, and skipping ONE token is not
      // enough to act on that. The statement is split on whitespace, so
      // `-m 'add -S support'` arrives as four tokens and the `-S` in the
      // middle is a token of its own — a test asserting exactly this case
      // failed against the one-token version, which is why the skip runs to
      // the end of the quoted run rather than to the next token.
      if (token === "-m" || token === "--message") {
        index = endOfArgument(tokens, index + 1);
        continue;
      }

      // The explicit flag, as a whole token. `--gpg-sign=<keyid>` is the
      // documented form for naming a key and is the same act, so it counts;
      // `--gpg-sign-something` is not a spelling git has and does not.
      if (token === "-S" || token === "--gpg-sign") return true;
      if (token !== undefined && token.startsWith("--gpg-sign=")) return true;

      // The inline config override, matched as a `-c` and its value
      // together so a literal `commit.gpgsign=true` appearing as an
      // argument to something else is not read as one.
      if (token === "-c") {
        const setting = tokens[index + 1];
        if (setting !== undefined && /^(commit|tag)\.gpgsign=(true|yes|on|1)$/i.test(setting)) {
          return true;
        }
      }
    }

    return false;
  });
}
