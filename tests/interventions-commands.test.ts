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
import { isBroadProcessKill, isMergeAttempt } from "@/lib/interventions/commands";

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
