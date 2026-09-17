// `forcesCommitSigning` and the entry that reads it — MILESTONES.md #128.
//
// **The negative half is written first and is the larger half**, following
// the reasoning `commands.ts` states for the whole module: a shape it fails
// to recognise costs one un-nudged call, and a shape it wrongly recognises
// costs a false nudge on a command that was fine. This check is materially
// easier to get wrong than its mirror, because `-S` is a single letter that
// appears legitimately as message text, as a value, and as an unrelated
// option — where `--no-gpg-sign` is unambiguous.
//
// So the cases below are built around the ways a naive `includes("-S")`
// would fire: inside a commit message, on a command that creates no commit,
// and as the opposite intent.
import { describe, expect, it } from "vitest";
import { forcesCommitSigning, suppressesCommitSigning } from "@/lib/interventions/commands";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { evaluate } from "@/lib/interventions/registry";
import type { InterventionContext } from "@/lib/interventions/types";

const ENTRY_ID = "commit-signing-forced-on-the-command-line";

async function fires(context: InterventionContext): Promise<boolean> {
  const findings = await evaluate({
    entries: BUILTIN_INTERVENTIONS,
    phase: "pre",
    context,
  });
  return findings.some((finding) => finding.id === ENTRY_ID);
}

describe("forcesCommitSigning recognises a forced signature", () => {
  it.each([
    ["git commit -S -m 'x'"],
    ["git commit --gpg-sign -m 'x'"],
    ["git commit -m 'x' -S"],
    ["git commit --gpg-sign=ABCD1234 -m 'x'"],
    ["git -c commit.gpgsign=true commit -m 'x'"],
    ["git -c commit.gpgsign=TRUE commit -m 'x'"],
    // Every verb that can create a commit, not just `commit`.
    ["git merge -S main"],
    ["git rebase -S main"],
    ["git cherry-pick -S abc123"],
    ["git revert -S abc123"],
    // A statement anywhere in a compound command still counts.
    ["npm test && git commit -S -m 'x'"],
  ])("matches %s", (command) => {
    expect(forcesCommitSigning(command)).toBe(true);
  });
});

describe("forcesCommitSigning does not fire on the shapes that merely look like it", () => {
  // **The case that breaks a substring check.** `-S` inside a commit message
  // is prose, and the token after `-m` is skipped precisely so this cannot
  // fire. Breaks if the `-m`/`--message` skip is removed from the loop.
  it.each([
    ["git commit -m 'add -S support'"],
    ["git commit --message '-S'"],
    ["git commit -m 'document --gpg-sign'"],
  ])("does not match a signing flag quoted in a message: %s", (command) => {
    expect(forcesCommitSigning(command)).toBe(false);
  });

  // The default is not the finding. Reading a bare commit as forcing would
  // nudge on every commit in the system.
  it("does not match a plain commit", () => {
    expect(forcesCommitSigning("git commit -m 'x'")).toBe(false);
  });

  // The opposite intent belongs to the mirror entry. Matching it here would
  // fire both entries on one command.
  it.each([
    ["git commit --no-gpg-sign -m 'x'"],
    ["git -c commit.gpgsign=false commit -m 'x'"],
    ["git -c commit.gpgsign=0 commit -m 'x'"],
  ])("does not match a suppressed signature: %s", (command) => {
    expect(forcesCommitSigning(command)).toBe(false);
    expect(suppressesCommitSigning(command)).toBe(true);
  });

  // Scoped by verb, so a flag of the same spelling on a read command cannot
  // fire it. `git log -S<string>` is a real and common flag — it searches
  // for commits changing an occurrence of the string — and is nothing to do
  // with signing.
  it.each([["git log -S needle"], ["git log -S'needle'"], ["git diff -S needle"]])(
    "does not match -S on a command that creates no commit: %s",
    (command) => {
      expect(forcesCommitSigning(command)).toBe(false);
    },
  );

  // `git` must be the verb of the statement, not an argument to something
  // else — the same rule `invokesGitSubcommand` enforces for every entry.
  it("does not match a command that merely mentions one", () => {
    expect(forcesCommitSigning("echo git commit -S -m x")).toBe(false);
  });

  // Changing the machine's standing configuration is a different act,
  // addressed to a different decision — mirroring the exclusion
  // `suppressesCommitSigning` documents for the same command.
  it("does not match a change to the standing configuration", () => {
    expect(forcesCommitSigning("git config --global commit.gpgsign true")).toBe(false);
  });

  it("does not match an empty or whitespace command", () => {
    expect(forcesCommitSigning("")).toBe(false);
    expect(forcesCommitSigning("   ")).toBe(false);
  });
});

describe("the entry it serves", () => {
  it("is registered, is a pre nudge, and fires on a forced signature", async () => {
    const entry = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === ENTRY_ID);
    expect(entry).toBeDefined();
    expect(entry?.phase).toBe("pre");
    expect(entry?.defaultLevel).toBe("nudge");
    expect(entry?.audience).toBe("agent");
    expect(await fires({ command: "git commit -S -m 'x'" })).toBe(true);
  });

  // A predicate reads only the context handed to it. With no command there
  // is nothing to recognise, and the honest answer is no finding rather than
  // a guess — the contract every entry in this registry is held to.
  it("says nothing when no command is carried", async () => {
    expect(await fires({})).toBe(false);
    expect(await fires({ itemId: "i1", itemState: "executing" })).toBe(false);
  });

  it("does not fire on the command its mirror is about", async () => {
    expect(await fires({ command: "git commit --no-gpg-sign -m 'x'" })).toBe(false);
  });

  // Both signing entries are about the same call, so a command carrying
  // neither flag must leave both silent — the property that keeps the pair
  // from covering every commit between them.
  it("leaves a plain commit unremarked by either signing entry", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git commit -m 'x'" },
    });
    const signingFindings = findings.filter((finding) => finding.id.includes("signing"));
    expect(signingFindings).toEqual([]);
  });

  it("carries the command on the finding, so the event records what was seen", async () => {
    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      phase: "pre",
      context: { command: "git commit -S -m 'x'" },
    });
    const finding = findings.find((candidate) => candidate.id === ENTRY_ID);
    expect(finding?.data).toEqual({ command: "git commit -S -m 'x'" });
  });

  // Both messages exist and neither is the other — the registry requires
  // both, and an entry whose prominent form merely repeats the plain one
  // gives the front end nothing to escalate to.
  it("ships a plain and a prominent message that differ", () => {
    const entry = BUILTIN_INTERVENTIONS.find((candidate) => candidate.id === ENTRY_ID);
    expect(entry?.messages.plain).toBeTruthy();
    expect(entry?.messages.prominent).toBeTruthy();
    expect(entry?.messages.plain).not.toEqual(entry?.messages.prominent);
    // The remedy is the point of the message: both name the flag-free form.
    expect(entry?.messages.plain).toContain("without the flag");
    expect(entry?.messages.prominent).toContain("without the flag");
  });
});
