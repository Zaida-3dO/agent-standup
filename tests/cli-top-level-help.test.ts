// The help surface for the four commands that are not `<noun> <verb>` pairs.
//
// These tests exist because of a specific reported failure, found by walking
// the new-user path from a clean install: `standup --help` mentioned `init`,
// `mcp` and `doctor` **zero times**, and `standup init --help` printed the
// global help and exited 0 — a plausible, specific answer about a different
// subject, which reads as "there is no `init`" when `init` exists and works.
//
// Both had one cause in `runCli`: the `--help` early return sat *above* the
// single-word dispatches, and `helpText()` was built from `COMMANDS`, which
// those four are deliberately not in.
import { describe, expect, it } from "vitest";
import { EXIT } from "@/lib/cli/envelope";
import { helpText, runCli } from "@/lib/cli/run";
import { TOP_LEVEL_COMMANDS, lookupTopLevelCommand } from "@/lib/cli/commands-top-level";
// The parser's own flag list, so the help-vs-parser checks below derive
// their expectation from the code under test rather than restating it.
import { INIT_FLAG_NAMES } from "@/lib/cli/init";

/** The envelope's data, or a failure if it was not an `ok` one. */
function okData(envelope: { ok: boolean; data?: unknown }): Record<string, unknown> {
  expect(envelope.ok).toBe(true);
  return envelope.data as Record<string, unknown>;
}

describe("standup --help — the commands a new user needs first", () => {
  // The literal regression. A mutant that drops `setup` from `helpText()`,
  // or empties `TOP_LEVEL_COMMANDS`, fails here — which is exactly the state
  // the product shipped in.
  it.each(["init", "doctor", "mcp", "hook"])("names `%s`", (name) => {
    const setup = helpText().setup;
    expect(setup.some((line) => line.startsWith(`${name} —`))).toBe(true);
  });

  it("names every one of them and describes each, with no blank summaries", () => {
    const setup = helpText().setup;
    expect(setup).toHaveLength(TOP_LEVEL_COMMANDS.length);
    for (const line of setup) {
      // `<name> — <summary> (`standup <name> --help`)`. The em dash has to
      // have text after it: a table row added with an empty summary is a
      // broken help entry, not a nit.
      const summary = line.split(" — ")[1] ?? "";
      expect(summary.length).toBeGreaterThan(20);
    }
  });

  it("tells each of them how to get more, by a command that actually works", async () => {
    // Not cosmetic: the help promises `standup <name> --help`, and that
    // promise is the thing that was broken. This asserts the promise and the
    // behaviour agree, so neither can drift from the other.
    for (const command of TOP_LEVEL_COMMANDS) {
      expect(helpText().setup.join("\n")).toContain(`\`standup ${command.name} --help\``);

      const outcome = await runCli([command.name, "--help"], { env: {} });
      expect(outcome.exitCode).toBe(EXIT.OK);
      expect(okData(outcome.envelope)["command"]).toBe(command.name);
    }
  });

  it("states the three setup facts a new user otherwise meets as a failure", () => {
    const requires = helpText().requires.join("\n");
    // Postgres is not swappable, Node is enforced, and the sweep has no
    // internal timer. Each of these is a thing the product will otherwise
    // teach you by refusing or by leaking claims.
    expect(requires).toMatch(/Postgres/);
    expect(requires).toMatch(/not swappable/i);
    expect(requires).toMatch(/Node >= 24/);
    expect(requires).toMatch(/sweep/i);
    expect(requires).toMatch(/cron|scheduler/i);
  });

  it("lists the noun/verb operations alongside the setup commands", () => {
    // Help carries both halves at once: the operations are what the tool is
    // for, and the setup commands are how a person gets to them. A help text
    // holding only one of the two is incomplete whichever one is missing.
    const help = helpText();
    expect(help.commands.length).toBeGreaterThan(40);
    expect(help.nouns).toContain("item");
  });
});

describe("standup <command> --help — describes that command, never the global help", () => {
  it.each(TOP_LEVEL_COMMANDS.map((c) => c.name))("describes `%s`", async (name) => {
    const outcome = await runCli([name, "--help"], { env: {} });
    const data = okData(outcome.envelope);

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(data["command"]).toBe(name);
    expect(String(data["usage"])).toContain(`standup ${name}`);
    expect(String(data["summary"]).length).toBeGreaterThan(20);
    expect((data["detail"] as readonly string[]).join("\n").length).toBeGreaterThan(80);
  });

  it("does NOT return the global help — the exact bug this fixes", async () => {
    // The tell. Global help has `nouns` and `commands` keys; a command's own
    // help has `command` and `detail`. Before the fix this returned the
    // former for every one of these. Moving the `--help` return back above
    // the dispatch makes every assertion below fail.
    for (const command of TOP_LEVEL_COMMANDS) {
      const data = okData((await runCli([command.name, "--help"], { env: {} })).envelope);
      expect(data).not.toHaveProperty("nouns");
      expect(data).not.toHaveProperty("commands");
      expect(data).toHaveProperty("detail");
    }
  });

  it("answers with no configuration at all, like the commands it describes", async () => {
    // `init` and `doctor` exist precisely for the unconfigured case, so
    // their help must not need configuration either. An implementation that
    // resolved config before rendering help would fail here.
    const outcome = await runCli(["init", "--help"], { env: {} });
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(JSON.stringify(outcome.envelope)).not.toContain("Neither STANDUP_URL");
  });

  it("never prints a plausible-but-wrong answer for an unknown command", async () => {
    // The failure class this whole row is about. `standup nonsense --help`
    // has no entry, so it falls through to the global help — which is
    // correct here, because the global help is genuinely the answer to "what
    // can this thing do". What must not happen is a *specific* answer about
    // the wrong subject.
    const data = okData((await runCli(["nonsense", "--help"], { env: {} })).envelope);
    expect(data).toHaveProperty("nouns");
    expect(data).not.toHaveProperty("command");
  });

  // Pinned against the parser, in BOTH directions — which the earlier
  // version of this test only claimed to do. It restated the five flag names
  // as literals in this file, so it asserted "the help contains these five
  // strings", not "the help matches the parser". Mutation testing found the
  // gap: renaming a documented flag to one `readInitFlags` does not read
  // (`--app-password` -> `--app-secret` in the help table) left all 18 tests
  // green while `standup init --help` advertised a silently-ignored flag.
  //
  // `INIT_FLAG_NAMES` is the parser's own list — `readInitFlags` iterates
  // exactly it — so the expectation below is derived from the code under
  // test rather than from a copy that can go stale.
  it("documents every flag the parser reads", async () => {
    const detail = (lookupTopLevelCommand("init")?.detail as readonly string[]).join("\n");
    for (const name of INIT_FLAG_NAMES) {
      expect(detail).toContain(`--${name}`);
    }
  });

  // The direction that was missing. Help drifting ahead of the parser is
  // how a command comes to advertise a flag it ignores, and a user who
  // passes it gets silence rather than an error.
  it("documents no flag the parser does not read", async () => {
    const command = lookupTopLevelCommand("init");
    const text = [command?.usage ?? "", ...((command?.detail as readonly string[]) ?? [])].join(
      "\n",
    );
    // Every long flag the help mentions, taken from the text itself rather
    // than listed here — so a newly documented flag is picked up without
    // this test being edited.
    const documented = new Set(
      [...text.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1] as string),
    );
    const read = new Set<string>(INIT_FLAG_NAMES);
    expect([...documented].filter((flag) => !read.has(flag))).toEqual([]);
  });

  it("leaves `--help` on a noun/verb command answering the global help", async () => {
    // Unchanged behaviour, asserted so the reorder cannot have broken it.
    const data = okData((await runCli(["item", "get", "--help"], { env: {} })).envelope);
    expect(data).toHaveProperty("nouns");
  });

  it("refuses `--help` given a value, rather than describing anything", async () => {
    const outcome = await runCli(["init", "--help=yes"], { env: {} });
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
  });
});
