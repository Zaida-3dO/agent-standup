// Command recognition for the intervention catalogue — MILESTONES.md #128,
// `src/lib/interventions/commands.ts`.
//
// **The rejections are the point.** A recogniser is trivially green against
// a list of things it should match; what decides whether it is safe to hang
// a block on is the list of things it must NOT match, because a false
// positive here refuses a call that was fine and teaches a session to
// distrust the guard. So each suite below pairs its matches with the
// near-misses that would be caught by a lazier pattern.
import { describe, expect, it } from "vitest";
import {
  allowsOnlyFastForward,
  isBroadProcessKill,
  isMergeAttempt,
  isMergeLanding,
} from "@/lib/interventions/commands";

describe("isMergeAttempt", () => {
  it("recognises the three shapes that land work", () => {
    for (const command of [
      "git merge feature",
      "git merge --no-ff feature",
      "git pull",
      "git pull origin main",
      "gh pr merge 12 --squash",
      "gh pr merge --squash --delete-branch",
      // Global options before the subcommand — git accepts them, so the
      // subcommand is not reliably the second token.
      "git -C /some/path merge feature",
      "git --no-pager merge feature",
      "git -c user.name=x merge feature",
      // Behind another statement in a compound command.
      "npm test && git merge feature",
    ]) {
      expect(isMergeAttempt(command), command).toBe(true);
    }
  });

  it("does not recognise commands that finish or discard a merge", () => {
    // These end a merge rather than starting one. None introduces an
    // unreviewed commit, so blocking them would refuse the cleanup after a
    // block rather than the merge itself — leaving a session stuck in a
    // conflicted state with no way out.
    for (const command of ["git merge --abort", "git merge --continue", "git merge --quit"]) {
      expect(isMergeAttempt(command), command).toBe(false);
    }
  });

  it("does not recognise commands that merely compute or read", () => {
    for (const command of [
      "git merge-base main HEAD",
      "git merge-tree main feature",
      "git log --merges",
      "git status",
      "git fetch origin",
      // The two things a session watching its own PR runs constantly. A
      // recogniser matching bare `gh pr` would fire on every poll.
      "gh pr view 12",
      "gh pr checks 12 --watch",
      "gh pr list",
      // `git` as an argument to something else, not as the verb.
      "echo git merge",
      "grep -rn 'git merge' docs/",
    ]) {
      expect(isMergeAttempt(command), command).toBe(false);
    }
  });

  // ── Row f296b059-e867-456f-af2a-d11af92a34c4 ────────────────────────────
  //
  // Both directions, because this is the pair that matters: the fix is only
  // worth having if the false positive is gone AND the true positive it was
  // hiding among is still caught. The plausible mistake when narrowing an
  // allow is widening it too far — letting a real merge through — so the
  // second test below is the one to check first if either is ever edited.

  it("does not recognise a fast-forward-only update as a merge", () => {
    // Breaks if the `allowsOnlyFastForward` early return is removed from the
    // `pull` branch of `isMergeAttempt` (deleting the one `return false`),
    // which is the exact state that produced the false positive: `git pull
    // --ff-only` is how every session catches up before starting work, and
    // it was refused with a message about missing reviews.
    //
    // `--ff-only` makes git abort rather than merge when the update is not a
    // fast-forward, so no unreviewed history can arrive by this route.
    for (const command of [
      "git pull --ff-only",
      "git pull --ff-only origin main",
      "git pull origin main --ff-only",
      "git merge --ff-only origin/main",
      // The compound form the isolating session actually ran.
      "git checkout main && git pull --ff-only",
      // Global options still have to be skipped to find the subcommand.
      "git -C /some/path pull --ff-only",
    ]) {
      expect(isMergeAttempt(command), command).toBe(false);
    }
  });

  it("still recognises a pull that can merge divergent history", () => {
    // The direction the fix must not break. Breaks if the `pull` branch is
    // widened to return false for any pull (e.g. changing the guarded
    // `if (allowsOnlyFastForward(trimmed)) return false;` to a bare
    // `return false`), or if `allowsOnlyFastForward` is loosened to a
    // substring test that ignores flag order.
    for (const command of [
      // No constraint at all: git will build a merge commit out of divergent
      // history without being asked.
      "git pull",
      "git pull origin main",
      "git pull --no-rebase origin main",
      // The last flag wins, exactly as it does in git. A `.includes("--ff-only")`
      // check would wave both of these through, and they can merge.
      "git pull --ff-only --no-ff origin main",
      "git merge --ff-only --no-ff origin/main",
      // `--ff` is git's default, not a constraint: it fast-forwards when it
      // can and merges when it cannot.
      "git pull --ff origin main",
      "git merge --ff origin/main",
      // A near-miss spelling is not the flag. Under-matching here is the
      // safe direction — it stays recognised as a merge.
      "git pull --ff-only=yes",
      "git pull --ff-onlyish",
    ]) {
      expect(isMergeAttempt(command), command).toBe(true);
    }
  });
});

describe("isMergeLanding", () => {
  // The delivery limb's recogniser, deliberately narrower than
  // `isMergeAttempt`. The two answer different questions and the suite
  // below exists mostly to pin the ONE case where they disagree.

  it("recognises the shapes that close a row", () => {
    for (const command of [
      "git merge feature",
      "git merge --no-ff feature",
      "git merge origin/main",
      "gh pr merge 12 --squash",
      "gh pr merge --squash --delete-branch",
      // Global options before the subcommand, as `isMergeAttempt` handles.
      "git -C /some/path merge feature",
      "git --no-pager merge feature",
      // `gh` with its own options before the subcommand pair.
      "gh --repo owner/name pr merge 12",
    ]) {
      expect(isMergeLanding(command), command).toBe(true);
    }
  });

  it("does NOT recognise `git pull`, which is where it parts from isMergeAttempt", () => {
    // **The case this function exists for.** Breaks if the body is ever
    // reduced to a call to `isMergeAttempt` — the obvious simplification,
    // and the wrong one. A pull catches a branch *up*; it closes nothing,
    // so no finding can become invisible because of it, and it is the
    // highest-frequency git command a session runs. Widening the delivery
    // gate onto it would buy zero findings and put two lookups on that
    // path.
    for (const command of [
      "git pull",
      "git pull origin main",
      "git pull --ff-only",
      "git pull --no-ff origin main",
      "git pull --no-rebase origin main",
      "git -C /some/path pull",
    ]) {
      expect(isMergeLanding(command), command).toBe(false);
      // And the contrast that makes the point: the approval limb's
      // recogniser still catches the ones that can write a merge commit.
      // If these two ever agree on `git pull`, one of them is wrong.
      if (!command.includes("--ff-only")) {
        expect(isMergeAttempt(command), command).toBe(true);
      }
    }
  });

  it("does not recognise the merge shapes that land nothing", () => {
    for (const command of [
      // End a merge already in progress rather than starting one. Breaks if
      // the `--(abort|continue|quit)` early return is deleted.
      "git merge --abort",
      "git merge --continue",
      "git merge --quit",
      // Moves a pointer to a descendant; writes no merge commit. Breaks if
      // the `allowsOnlyFastForward` early return is deleted.
      "git merge --ff-only origin/main",
      // Compute-only, and a distinct subcommand token.
      "git merge-base main HEAD",
      "git merge-tree main feature",
      // The reads a session runs constantly while watching its own PR.
      // Breaks if the `gh` pattern is loosened to match `gh pr` alone.
      "gh pr view 12",
      "gh pr list",
      "gh pr checks",
      // Anchored at the statement start, so a mention is not an invocation.
      "echo gh pr merge 12",
      "echo git merge feature",
    ]) {
      expect(isMergeLanding(command), command).toBe(false);
    }
  });

  it("reads each statement of a compound command", () => {
    // Breaks if `splitStatements` is dropped and the whole string is tested
    // at once, since the anchored `gh` pattern would then miss a merge that
    // is not the first statement.
    expect(isMergeLanding("npm test && gh pr merge 12 --squash")).toBe(true);
    expect(isMergeLanding("git fetch && git merge origin/main")).toBe(true);
    // Still false when every statement is innocent.
    expect(isMergeLanding("git fetch && git pull --ff-only")).toBe(false);
  });
});

describe("allowsOnlyFastForward", () => {
  it("reads the flags in order and lets the last one win", () => {
    // Pinned separately from `isMergeAttempt` because this is where the
    // widening mistake would actually be made. Breaks if the loop stops
    // resetting on `--no-ff`/`--ff` (deleting the `else if` branch), which
    // turns the function into "does --ff-only appear anywhere" — and that
    // reading calls `git merge --ff-only --no-ff` fast-forward-only when it
    // is a forced merge commit.
    expect(allowsOnlyFastForward("git pull --ff-only")).toBe(true);
    expect(allowsOnlyFastForward("git pull --no-ff --ff-only")).toBe(true);

    expect(allowsOnlyFastForward("git pull --ff-only --no-ff")).toBe(false);
    expect(allowsOnlyFastForward("git pull --ff-only --ff")).toBe(false);
    expect(allowsOnlyFastForward("git pull")).toBe(false);
    // A flag has to be its own token: `--ff-only` inside a longer word, or
    // as part of a `--flag=value`, is a different flag.
    expect(allowsOnlyFastForward("git pull --ff-onlyish")).toBe(false);
    expect(allowsOnlyFastForward("git commit -m 'use --ff-only'")).toBe(false);
  });
});

describe("isBroadProcessKill", () => {
  it("recognises a kill that names an image rather than a process", () => {
    // The case the entry exists for: these take out every sibling agent's
    // processes and the caller cannot tell from the command that they did.
    for (const command of ["taskkill /F /IM node.exe", "pkill node", "killall node"]) {
      expect(isBroadProcessKill(command), command).toBe(true);
    }
  });

  it("recognises a kill it cannot decompose as broad", () => {
    // An unread selector is not an empty one — the same fail-closed reading
    // `kill_guard` applies. A parser that reported "no targets" here would
    // hand back a command that kills by filter, unguarded.
    expect(isBroadProcessKill('taskkill /F /FI "IMAGENAME eq node.exe"')).toBe(true);
  });

  it("does not recognise a kill scoped to process ids", () => {
    // Scoped however long the list is: breadth is the question, not
    // violence. `-9` on a pid the caller owns is not this entry's business.
    for (const command of ["kill 1234", "kill -9 1234", "kill 1234 5678", "taskkill /PID 1234"]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  // row f53e667a-97da-4b10-bded-8a3c50836a85: this is the function the
  // guard's "kill by process id instead" message actually gates on. A
  // Windows Bash tool call reaches the hook already wrapped as `powershell
  // -NoProfile -Command "<command>"` — not a choice the agent made — so a
  // PID-scoped kill written exactly as the message recommends must NOT
  // read as broad merely for arriving through that wrapper.
  it("does not recognise a pid-scoped kill through the wrapper Windows always uses", () => {
    for (const command of [
      'powershell -NoProfile -Command "Stop-Process -Id 130580 -Force"',
      'powershell -Command "Stop-Process -Id 130580 -Force"',
      'cmd /c "taskkill /PID 130580 /F"',
      "sh -c 'kill 130580'",
    ]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  // row c8e61fe9-179a-4475-b835-4bcce5da9d5a: the two forms a crew was
  // refused three times, verbatim as reported. Both name a process id and
  // neither names an image, so both must pass the entry whose message tells
  // the caller to kill by process id.
  it("does not recognise the pid-scoped forms reported as refused", () => {
    for (const command of ["taskkill /PID 95040 /F", "Stop-Process -Id 95040 -Force"]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  // The two doors that were still shut at the time of that row: a pid list
  // in PowerShell's native plural spelling, and a pid alongside the flag
  // that stops it erroring when the process has already gone.
  it("does not recognise a pid list or a pid beside a reporting parameter", () => {
    for (const command of [
      "Stop-Process -Id 1,2,3 -Force",
      "Stop-Process -Id 95040 -ErrorAction SilentlyContinue",
      'powershell -NoProfile -Command "Stop-Process -Id 1,2,3 -ErrorAction SilentlyContinue"',
    ]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  // The paired negative control for that widening. Each differs from an
  // allowed case above by one token, and each must still be refused —
  // otherwise the pid-list and reporting-parameter paths have become a way
  // to smuggle an image target past the entry.
  it("still recognises a broad kill that carries a pid list or a reporting parameter", () => {
    for (const command of [
      "Stop-Process -Id 1,2 -Name node",
      "Stop-Process -ErrorAction SilentlyContinue -Name node",
      "Stop-Process -Id node,foo",
      "Stop-Process -Id 1,,2",
      "Stop-Process -ErrorAction SilentlyContinue",
    ]) {
      expect(isBroadProcessKill(command), command).toBe(true);
    }
  });

  // The negative control: the same wrappers must still read as broad when
  // the inner command actually is — this fix must not become "trust
  // anything a wrapper carries".
  it("still recognises a broad kill through the same wrappers", () => {
    for (const command of [
      'powershell -NoProfile -Command "Stop-Process -Name node -Force"',
      'cmd /c "taskkill /F /IM node.exe"',
      'sh -c "taskkill /F /FI \\"IMAGENAME eq node.exe\\""',
    ]) {
      expect(isBroadProcessKill(command), command).toBe(true);
    }
  });

  // ── Row bf28b8a9-7bc9-4bfe-a48c-4d4b5e3d5e09 ──────────────────────────
  //
  // Eight feedback notes between 2026-08-24 and 2026-09-13 reported this
  // entry refusing a PID-scoped kill as a name-wide sweep. The cause was
  // `-ErrorAction` reaching the parser's unknown-flag branch and making the
  // command `unparseable`, which this function blocks on — so the pid was
  // named in plain sight and never read. Fixed by `bd935c4` (2026-09-01).
  //
  // Reports continued after the fix because the sessions filing them were
  // talking to an older build: the 2026-09-13 note's seven-pid list parses
  // to seven pid targets and is allowed from `bd935c4` onward, so a build
  // that refused it necessarily predated 2026-09-01. That is a behavioural
  // dating, not an inference from the refusal wording — the wording those
  // notes quote ran from `70b8536` (08-18) until `bea4478` (09-13) and is
  // still present at `bd935c4` itself, so it cannot date a build any more
  // precisely than "before 09-13".
  //
  // Pinned at this level as well as in the parser because this is the
  // function the block actually hangs on.
  const stop = `Stop-${"Process"}`;
  const taskkill = `task${"kill"}`;

  it("does not recognise the doubled-slash pid form Git Bash produces", () => {
    // Six of the eight notes used this spelling, and it was pinned nowhere.
    // Git Bash rewrites a leading `/` to `//` to stop MSYS path mangling,
    // so this is what a Windows crew types — not a choice it made.
    for (const command of [
      `${taskkill} //PID 29160 //F`,
      `${taskkill} //PID 30348 //F`,
      `${taskkill} //PID 34640 //F`,
      `${taskkill} //PID 27524 //F`,
      `${taskkill} //PID 17272 //F`,
      `${taskkill} //PID 32788 //F`,
      `${taskkill} //F //PID 40578`,
      `${taskkill} /PID 51588 /F`,
      `${taskkill} /PID 123 /PID 456`,
      "kill -9 40578",
      "kill 123 456",
      `cmd //c "${taskkill} /PID 32788 /T /F"`,
      `powershell -Command "${stop} -Id 40578 -Force"`,
      `powershell -NoProfile -Command "${stop} -Id 51588 -Force"`,
    ]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  it("does not recognise the reported commands that carry -ErrorAction", () => {
    // The middle entry is the one that settles the argument: eight reports
    // blamed `-Force`, and removing it entirely changes nothing. The token
    // that caused every refusal was `-ErrorAction`.
    for (const command of [
      `${stop} -Id 12244 -Force -ErrorAction SilentlyContinue`,
      `${stop} -Id 12244 -ErrorAction SilentlyContinue`,
      `${stop} -Id 39864,50912,47244,44644,55044,27488,49820 -Force -ErrorAction SilentlyContinue`,
      // Same list without the reporting parameter. It failed pre-fix for a
      // second, independent reason (the singular-integer limitation), so
      // this is not a duplicate of the line above it.
      `${stop} -Id 39864,50912,47244,44644,55044,27488,49820 -Force`,
    ]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });

  // ── The half of this row that matters more.
  //
  // A suite proving only that things are ALLOWED would pass against a
  // function that returned false unconditionally — i.e. against a guard
  // deleted entirely. These are the sweeps that must keep refusing, and
  // several differ from an allowed case above by a single token.
  it("still recognises the sweeps, including the ones spelled the same way", () => {
    for (const command of [
      // Paired with the doubled-slash allows above: identical rewriting,
      // image selector. If stripping the slashes ever waves a command
      // through on spelling rather than on target, this is what catches it.
      `${taskkill} //IM node.exe //F`,
      `${taskkill} /IM node.exe`,
      `${taskkill} /F /IM node.exe /T`,
      "pkill -f node",
      // The author of the 2026-09-07 note agreed this refusal was fair.
      'pkill -f "haven-wt-widget-gap"',
      `${stop} -Name node -Force`,
      // Adversarial probes against the enumerated-skip design: a selector
      // this build cannot read must stay blocked rather than decompose to
      // an empty, allowable target set. `/FI` and `-InputObject` are the
      // two the parser's own comment warns a blanket unknown-flag skip
      // would swallow.
      `${taskkill} /FI "IMAGENAME eq node.exe" /F`,
      `${stop} -InputObject $p -Force`,
      `${stop} -ErrorAction SilentlyContinue -Name node`,
      `${stop} -Id`,
      `${stop} -Id 123,,456`,
      `${stop} -Id abc`,
      `${taskkill} /IM node.exe /ErrorAction x`,
    ]) {
      expect(isBroadProcessKill(command), command).toBe(true);
    }
  });

  it("does not recognise commands that end no process", () => {
    for (const command of [
      "ls -la",
      "git status",
      "npm test",
      // Words containing a kill verb, which a bare substring match would
      // catch.
      "echo killall",
      "grep -rn kill src/",
    ]) {
      expect(isBroadProcessKill(command), command).toBe(false);
    }
  });
});
