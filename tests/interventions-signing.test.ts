// I17 — a commit that explicitly suppresses signing.
//
// The entry is a **nudge**, and everything below is written around why.
// The catalogue row specced I17 as a merge-time block that verifies
// signatures against a trusted-key set, and that is genuinely unbuildable
// here: a signature is a property of a commit object, and no row in this
// schema holds one. But that was never the only useful version. What the
// owner actually asked to catch is narrower and needs nothing the server
// does not already have — *a command that goes out of its way to turn
// signing off* — which is command text, already on `InterventionContext`.
//
// So the risk this carries is not a wrongly-blocked merge but a wrongly
// nudged commit, and the negative half of every block below is the half
// doing the work. In particular a bare `git commit` must never fire: the
// default is fine, and reading the absence of a flag as suppression would
// nudge on every commit in the system.

import { describe, expect, it } from "vitest";
import { suppressesCommitSigning } from "@/lib/interventions/commands";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import type { Intervention, InterventionContext } from "@/lib/interventions/types";

function entry(id: string): Intervention {
  const found = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no builtin entry ${id}`);
  return found;
}

async function fires(id: string, context: InterventionContext): Promise<boolean> {
  return (await entry(id).predicate(context)).triggered;
}

describe("suppressesCommitSigning", () => {
  it.each([
    // The flag, on each verb that can create a commit.
    "git commit --no-gpg-sign -m 'wip'",
    "git merge --no-gpg-sign main",
    "git rebase --no-gpg-sign main",
    "git cherry-pick --no-gpg-sign abc123",
    "git revert --no-gpg-sign abc123",
    // The inline config override — the spelling `invokesGitSubcommand`
    // skips past when it looks for the subcommand, so it has to be read
    // from the raw tokens or it is never seen at all.
    "git -c commit.gpgsign=false commit -m 'wip'",
    "git -c commit.gpgsign=FALSE commit -m 'wip'",
    "git -c commit.gpgsign=0 commit -m 'wip'",
    "git -c tag.gpgsign=false tag -a v1 -m x && git commit --no-gpg-sign -m x",
    // Buried in a compound statement: the suppression is still happening.
    "npm test && git commit --no-gpg-sign -m 'wip'",
  ])("recognises %s", (command) => {
    expect(suppressesCommitSigning(command)).toBe(true);
  });

  it.each([
    // **The default is fine.** This is the case that decides the whole
    // entry: a plain commit signs if signing is configured and does not if
    // it is not, and either way this call made no decision about it.
    "git commit -m 'an ordinary commit'",
    "git commit -am 'an ordinary commit'",
    "git merge main",
    "git rebase main",
    // The opposite intent. Firing on these would be exactly backwards.
    "git commit -S -m 'signed'",
    "git commit --gpg-sign -m 'signed'",
    "git -c commit.gpgsign=true commit -m 'signed'",
    // Standing configuration, not a commit. A different act, addressed to
    // a different decision, and one this entry has nothing to say about.
    "git config --global commit.gpgsign false",
    "git config commit.gpgsign false",
    // Ordinary reads. Nudging on these would nudge constantly.
    "git status",
    "git log --oneline -5",
    // Not git as the verb of the statement.
    "echo git commit --no-gpg-sign",
    "grep -r 'no-gpg-sign' docs/",
    // The string appears, but as message content rather than as a flag —
    // the reason the `-c` and its value are matched as a pair rather than
    // by searching the statement for the setting name.
    "git commit -m 'document why commit.gpgsign=false is set here'",
  ])("does not recognise %s", (command) => {
    expect(suppressesCommitSigning(command)).toBe(false);
  });
});

describe("I17 — explicitly suppressed commit signing", () => {
  it("fires on a suppressed commit and stays silent on an ordinary one", async () => {
    expect(
      await fires("commit-signing-explicitly-suppressed", {
        command: "git commit --no-gpg-sign -m 'wip'",
      }),
    ).toBe(true);
    // The whole point of the entry: the default is not the finding.
    expect(
      await fires("commit-signing-explicitly-suppressed", { command: "git commit -m 'wip'" }),
    ).toBe(false);
    // No command at all — a Write, an Edit. Nothing to read, nothing to say.
    expect(await fires("commit-signing-explicitly-suppressed", {})).toBe(false);
  });

  it("is a nudge, not a block", async () => {
    // Suppressing a signature is frequently legitimate — no key on this
    // machine, a scripted commit, a rebase of someone else's commits. The
    // honest response is to say the signature will be missing and let the
    // caller decide, which is what a nudge is. A block here would refuse
    // commands that were right, on a convention the installation may not
    // even have adopted.
    const found = entry("commit-signing-explicitly-suppressed");
    expect(found.defaultLevel).toBe("nudge");
    expect(found.phase).toBe("pre");
    expect(found.audience).toBe("agent");
  });

  it("says the default would have been fine, which is the actionable part", async () => {
    // A nudge that says only "you disabled signing" tells the reader
    // something they already know. What they can act on is that dropping
    // the flag restores the configured behaviour.
    const messages = entry("commit-signing-explicitly-suppressed").messages;
    expect(messages.plain).toMatch(/sign/i);
    expect(messages.prominent).toMatch(/sign/i);
    // Names the remedy rather than merely disapproving.
    expect(messages.plain).toMatch(/without the flag/i);
    expect(messages.prominent).toMatch(/without the flag/i);
    // And says the default is the thing being overridden, which is the part
    // that makes the advice make sense rather than sound arbitrary.
    expect(messages.prominent).toMatch(/default/i);
  });

  it("records the command it fired on, so the firing is reviewable", async () => {
    const verdict = await entry("commit-signing-explicitly-suppressed").predicate({
      command: "git commit --no-gpg-sign -m 'wip'",
    });
    expect(verdict.data).toMatchObject({ command: "git commit --no-gpg-sign -m 'wip'" });
  });
});
