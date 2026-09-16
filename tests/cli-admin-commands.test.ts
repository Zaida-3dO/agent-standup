// The `repo` · `area` · `machine` · `account` · `person` command-line nouns
// (MILESTONES.md #92, SCHEMA.md §20). Same shape as tests/cli-dispatch.ts's
// "input building" section: drives `runCommand` against a recording binding
// so the assertions are about dispatch + flag parsing, never about the
// service layer or a live database.
import { describe, expect, it } from "vitest";
import { EXIT, nouns, runCommand, verbsFor } from "@/lib/cli";
import type { Binding } from "@/lib/cli";

/** A binding that records every call and always accepts. */
function recorder(): Binding & { calls: { operation: string; input: unknown }[] } {
  const calls: { operation: string; input: unknown }[] = [];
  return {
    name: "direct",
    calls,
    async invoke(operation, input) {
      calls.push({ operation, input });
      return { ok: true, data: { operation } };
    },
  };
}

describe("repo", () => {
  it("list defaults includeArchived to false", async () => {
    const binding = recorder();
    await runCommand(["repo", "list"], binding);
    expect(binding.calls).toEqual([{ operation: "list_repos", input: { includeArchived: false } }]);
  });

  it("list --include-archived flips the flag", async () => {
    const binding = recorder();
    await runCommand(["repo", "list", "--include-archived"], binding);
    expect(binding.calls[0]?.input).toEqual({ includeArchived: true });
  });

  it("get reads the positional id", async () => {
    const binding = recorder();
    await runCommand(["repo", "get", "web"], binding);
    expect(binding.calls).toEqual([{ operation: "get_repo", input: { id: "web" } }]);
  });

  it("get refuses with no id, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["repo", "get"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("create passes the id and every provided flag through, kebab-case translated", async () => {
    const binding = recorder();
    await runCommand(
      [
        "repo",
        "create",
        "web",
        "--display-name",
        "Web",
        "--default-branch",
        "main",
        "--host",
        "example.test",
        "--needs-visual-review",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "create_repo",
        input: {
          id: "web",
          displayName: "Web",
          defaultBranch: "main",
          host: "example.test",
          needsVisualReview: true,
        },
      },
    ]);
  });

  it("create omits fields that were not given, rather than sending them as undefined keys", async () => {
    const binding = recorder();
    await runCommand(["repo", "create", "web"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["id", "needsVisualReview"]);
    expect(input.needsVisualReview).toBe(false);
  });

  it("update --archive sets archived: true", async () => {
    const binding = recorder();
    await runCommand(["repo", "update", "web", "--archive"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "web", archived: true });
  });

  it("update --unarchive sets archived: false", async () => {
    const binding = recorder();
    await runCommand(["repo", "update", "web", "--unarchive"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "web", archived: false });
  });

  it("update refuses --archive and --unarchive together, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["repo", "update", "web", "--archive", "--unarchive"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update with neither --archive nor --unarchive sends no archived key", async () => {
    const binding = recorder();
    await runCommand(["repo", "update", "web", "--display-name", "Website"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "web", displayName: "Website" });
  });
});

describe("area", () => {
  it("create reads the positional name", async () => {
    const binding = recorder();
    await runCommand(["area", "create", "Web Site"], binding);
    expect(binding.calls).toEqual([{ operation: "create_area", input: { name: "Web Site" } }]);
  });

  it("create refuses with no name", async () => {
    const binding = recorder();
    const outcome = await runCommand(["area", "create"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update renames and archives independently", async () => {
    const binding = recorder();
    await runCommand(["area", "update", "web", "--display-name", "Website"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "web", displayName: "Website" });

    await runCommand(["area", "update", "web", "--archive"], binding);
    expect(binding.calls[1]?.input).toEqual({ id: "web", archived: true });
  });

  it("merge reads both positionals in order", async () => {
    const binding = recorder();
    await runCommand(["area", "merge", "web", "website"], binding);
    expect(binding.calls).toEqual([
      { operation: "merge_areas", input: { from: "web", to: "website" } },
    ]);
  });

  it("merge passes a missing positional through as undefined rather than refusing it locally", async () => {
    // No CLI-side "needs two ids" check: the operation's own schema is what
    // refuses this, identically to the `http` and `mcp` adapters — see the
    // comment on the `merge` command in `../src/lib/cli/commands-admin.ts`.
    const binding = recorder();
    await runCommand(["area", "merge", "web"], binding);
    expect(binding.calls).toEqual([
      { operation: "merge_areas", input: { from: "web", to: undefined } },
    ]);
  });
});

describe("machine", () => {
  it("list takes no input", async () => {
    const binding = recorder();
    await runCommand(["machine", "list"], binding);
    expect(binding.calls).toEqual([{ operation: "list_machines", input: {} }]);
  });

  it("update with no flags sends only the name — no change to sourceGlobs", async () => {
    const binding = recorder();
    await runCommand(["machine", "update", "desktop"], binding);
    expect(binding.calls).toEqual([{ operation: "update_machine", input: { name: "desktop" } }]);
  });

  it("update --source-globs splits on commas and trims each entry", async () => {
    const binding = recorder();
    await runCommand(
      ["machine", "update", "desktop", "--source-globs", "apps/**, services/** ,tools/**"],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({
      name: "desktop",
      sourceGlobs: ["apps/**", "services/**", "tools/**"],
    });
  });

  it("update --source-globs '' (empty string) produces an explicit empty-array override, not omitted", async () => {
    const binding = recorder();
    await runCommand(["machine", "update", "desktop", "--source-globs", ""], binding);
    expect(binding.calls[0]?.input).toEqual({ name: "desktop", sourceGlobs: [] });
  });

  it("update --clear-source-globs sends sourceGlobs: null", async () => {
    const binding = recorder();
    await runCommand(["machine", "update", "desktop", "--clear-source-globs"], binding);
    expect(binding.calls[0]?.input).toEqual({ name: "desktop", sourceGlobs: null });
  });

  it("update refuses --source-globs and --clear-source-globs together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["machine", "update", "desktop", "--source-globs", "a/**", "--clear-source-globs"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });
});

describe("account", () => {
  it("list takes no input", async () => {
    const binding = recorder();
    await runCommand(["account", "list"], binding);
    expect(binding.calls).toEqual([{ operation: "list_accounts", input: {} }]);
  });

  it("update passes vendor, display-name and plan-type through", async () => {
    const binding = recorder();
    await runCommand(
      [
        "account",
        "update",
        "account-b",
        "--vendor",
        "anthropic",
        "--display-name",
        "Account B",
        "--plan-type",
        "subscription",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "update_account",
        input: {
          id: "account-b",
          vendor: "anthropic",
          displayName: "Account B",
          planType: "subscription",
        },
      },
    ]);
  });

  it("update --budget-windows parses JSON", async () => {
    const binding = recorder();
    await runCommand(
      ["account", "update", "account-a", "--budget-windows", '{"primary":{"enabled":false}}'],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({
      id: "account-a",
      budgetWindows: { primary: { enabled: false } },
    });
  });

  it("update --budget-windows refuses invalid JSON before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["account", "update", "account-a", "--budget-windows", "{not json"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update --clear-budget-windows sends budgetWindows: null", async () => {
    const binding = recorder();
    await runCommand(["account", "update", "account-a", "--clear-budget-windows"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "account-a", budgetWindows: null });
  });

  it("update refuses --budget-windows and --clear-budget-windows together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["account", "update", "account-a", "--budget-windows", "{}", "--clear-budget-windows"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });
});

describe("person", () => {
  // The noun SCHEMA.md §20 and §23.3 both name, and which this file's
  // subject module quoted in its own header while binding nothing. Every
  // assertion below reaches `runCommand` by the words a person types, so a
  // `person` entry that is absent, misspelled, or wired to the wrong
  // operation fails here rather than at a caller.
  it("list defaults includeArchived to false", async () => {
    const binding = recorder();
    await runCommand(["person", "list"], binding);
    expect(binding.calls).toEqual([
      { operation: "list_people", input: { includeArchived: false } },
    ]);
  });

  it("list --include-archived flips the flag", async () => {
    const binding = recorder();
    await runCommand(["person", "list", "--include-archived"], binding);
    expect(binding.calls[0]?.input).toEqual({ includeArchived: true });
  });

  it("list --limit is sent as a number, not the string that was typed", async () => {
    // `list_people` is the only paged read this file's nouns reach, and
    // `limit` is a `z.number()`. Passed through raw it would be `"5"` and
    // the schema would refuse it, so this pins the type as well as the
    // value — `toEqual` distinguishes 5 from "5".
    const binding = recorder();
    await runCommand(["person", "list", "--limit", "5"], binding);
    expect(binding.calls[0]?.input).toEqual({ includeArchived: false, limit: 5 });
  });

  it("list --limit refuses a non-number before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["person", "list", "--limit", "many"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("list --cursor passes the page cursor through", async () => {
    const binding = recorder();
    await runCommand(["person", "list", "--cursor", "user-a"], binding);
    expect(binding.calls[0]?.input).toEqual({ includeArchived: false, cursor: "user-a" });
  });

  it("update refuses with no id, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["person", "update"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update creates: id plus every provided flag, kebab-case translated", async () => {
    const binding = recorder();
    await runCommand(
      [
        "person",
        "update",
        "ope",
        "--display-name",
        "Ope",
        "--avatar",
        "ope.png",
        "--colour",
        "#336699",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "update_person",
        input: { id: "ope", displayName: "Ope", avatar: "ope.png", colour: "#336699" },
      },
    ]);
  });

  it("update omits fields that were not given, rather than sending them as undefined keys", async () => {
    // The distinction the operation is built on: omitted means "no change",
    // and it reads that off the key being absent.
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--display-name", "Ope"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["displayName", "id"]);
  });

  it("update --clear-avatar sends avatar: null, which an empty string cannot say", async () => {
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--clear-avatar"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "ope", avatar: null });
  });

  it("update refuses --avatar and --clear-avatar together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["person", "update", "ope", "--avatar", "ope.png", "--clear-avatar"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update --clear-colour sends colour: null", async () => {
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--clear-colour"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "ope", colour: null });
  });

  it("update refuses --colour and --clear-colour together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["person", "update", "ope", "--colour", "#336699", "--clear-colour"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update --notify-rules parses JSON and passes the stored snake_case spelling through untouched", async () => {
    // The adapter does **not** translate `when_all` to `whenAll`, on
    // purpose: `update_person` validates in the stored spelling precisely
    // so a rule that would parse back to zero conditions — and then
    // silently never fire — is refused on the way in. A helpful rewrite
    // here would defeat that check from behind it.
    const binding = recorder();
    await runCommand(
      [
        "person",
        "update",
        "ope",
        "--notify-rules",
        '[{"notify":["ope"],"when_all":[{"field":"state","op":"eq","value":"merged"}]}]',
      ],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({
      id: "ope",
      notifyRules: [{ notify: ["ope"], when_all: [{ field: "state", op: "eq", value: "merged" }] }],
    });
  });

  it("update --notify-rules refuses invalid JSON before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["person", "update", "ope", "--notify-rules", "{not json"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update --clear-notify-rules sends notifyRules: null", async () => {
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--clear-notify-rules"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "ope", notifyRules: null });
  });

  it("update refuses --notify-rules and --clear-notify-rules together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["person", "update", "ope", "--notify-rules", "[]", "--clear-notify-rules"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("update --archive sets archived: true", async () => {
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--archive"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "ope", archived: true });
  });

  it("update --unarchive sets archived: false", async () => {
    const binding = recorder();
    await runCommand(["person", "update", "ope", "--unarchive"], binding);
    expect(binding.calls[0]?.input).toEqual({ id: "ope", archived: false });
  });

  it("update refuses --archive and --unarchive together", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["person", "update", "ope", "--archive", "--unarchive"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("is a noun the help text lists, with exactly the verbs there are operations for", () => {
    // The defect this row fixes was not a broken command — it was a noun
    // that did not exist, so `standup --help` never mentioned `person` and
    // nothing pointed a stuck caller at it. This pins the discovery
    // surface, which is what a person encounters first.
    //
    // `verbsFor` is asserted exactly rather than with `toContain`: there is
    // no `get_person` operation to bind a `get` to, and a `person get`
    // appearing here would mean the command table had grown behaviour of
    // its own instead of reaching the service layer.
    expect(nouns()).toContain("person");
    expect(verbsFor("person")).toEqual(["list", "update"]);
  });
});
