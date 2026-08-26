// The `repo` · `area` · `machine` · `account` command-line nouns
// (MILESTONES.md #92, SCHEMA.md §20). Same shape as tests/cli-dispatch.ts's
// "input building" section: drives `runCommand` against a recording binding
// so the assertions are about dispatch + flag parsing, never about the
// service layer or a live database.
import { describe, expect, it } from "vitest";
import { EXIT, runCommand } from "@/lib/cli";
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
