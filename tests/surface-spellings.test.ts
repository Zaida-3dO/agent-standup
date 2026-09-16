// Every advertised invocation names a real binding — or names nothing.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// A spelling manufactured by string transformation — `standup
// ${name.replace(/_/g, " ")}` for the command line, the operation name for
// MCP unconditionally — is false for **97 of 100** operations on `cli` and
// **56** on `mcp`, measured against the real tables.
//
// The reason that survives review is that **a test can assert a derivation
// against its own output.** `expect(invocationFor("register_session",
// "cli")).toBe("`standup register session`")` passes for any derivation
// somebody writes, including one whose command does not exist. A test that
// restates the implementation cannot fail when the implementation is
// wrong, so every assertion here is anchored to a dispatch table.
//
// So everything below is checked against a table the system really
// dispatches on, never against a second copy:
//
//   - **`cli`** is fed through `lookupCommand`, the dispatcher itself, and
//     has to come back resolved to the same operation. That covers verb
//     order, aliases and existence in one assertion, and it cannot drift
//     from the command line because it *is* the command line's lookup.
//   - **`mcp`** is checked against the tool list `createMcpServer` builds
//     (`toolsFromOperations(exposedOperations(...))`), not against the
//     waiver table it is derived from — one step closer to what a caller
//     actually sees in `tools/list`.
import { describe, expect, it } from "vitest";
import { COMMANDS, lookupCommand } from "@/lib/cli/commands";
import { exposedOperations } from "@/lib/adapters/waivers";
import { toolsFromOperations } from "@/lib/mcp/tools";
import { listOperations } from "@/lib/service";
import { FOLDED_INTO, operationsOffMcp } from "@/lib/service/describe/reachability";
import { bindingsFor } from "@/lib/service/describe/bindings";
import { invocationFor, invocationWithArgumentFor, spellingsFor } from "@/lib/surfaces";

/** Every registered operation name. */
const OPERATIONS = listOperations()
  .map((operation) => operation.name)
  .sort();

/** The tool names an MCP caller really sees, built the way the server builds them. */
const MCP_TOOL_NAMES = new Set(
  toolsFromOperations(exposedOperations("mcp_http", listOperations())).map((tool) => tool.name),
);

/** Operations the command table binds, whatever the verb happens to be. */
const CLI_BOUND = new Set(COMMANDS.map((command) => command.operation));

describe("an advertised cli command resolves to the operation advertising it", () => {
  it.each(OPERATIONS)("%s", (operation) => {
    const { cli } = spellingsFor(operation, bindingsFor(operation));
    if (cli === undefined) {
      // Absent is only honest when there is genuinely nothing to name.
      expect(CLI_BOUND.has(operation)).toBe(false);
      return;
    }
    const words = cli.split(" ");
    expect(words[0]).toBe("standup");
    // The dispatcher, not a re-derivation of it. `lookupCommand` is what
    // the command line runs, so a string it rejects is a string a user
    // would have been told to type and then refused for.
    const resolved = lookupCommand(words.slice(1));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.match.command.operation).toBe(operation);
  });
});

describe("an advertised mcp tool is in the tool list", () => {
  it.each(OPERATIONS)("%s", (operation) => {
    const { mcp } = spellingsFor(operation, bindingsFor(operation));
    if (mcp === undefined) {
      expect(MCP_TOOL_NAMES.has(operation)).toBe(false);
      return;
    }
    expect(MCP_TOOL_NAMES.has(mcp)).toBe(true);
  });
});

describe("the whole surface, counted", () => {
  // The enumeration the fix was measured by, kept as a test so the count
  // cannot creep back up unnoticed. A new operation that binds nothing, or
  // a renamed verb, fails here rather than in a caller's terminal.
  it("advertises no invocation that does not exist", () => {
    const offMcp = operationsOffMcp();
    const false_: string[] = [];
    for (const operation of OPERATIONS) {
      const { cli, mcp } = spellingsFor(operation, bindingsFor(operation, offMcp));
      if (cli !== undefined) {
        const resolved = lookupCommand(cli.split(" ").slice(1));
        if (!resolved.ok || resolved.match.command.operation !== operation) {
          false_.push(`${operation}: cli "${cli}"`);
        }
      } else if (CLI_BOUND.has(operation)) {
        false_.push(`${operation}: omits a cli verb that exists`);
      }
      if (mcp !== undefined && !MCP_TOOL_NAMES.has(mcp)) {
        false_.push(`${operation}: mcp "${mcp}"`);
      } else if (mcp === undefined && MCP_TOOL_NAMES.has(operation)) {
        false_.push(`${operation}: omits an mcp tool that exists`);
      }
    }
    expect(false_).toEqual([]);
  });

  it("still names a real command wherever one exists, rather than going silent", () => {
    // The counterpart assertion, and the one that stops "fix it by omitting
    // everything" from passing. Option (b) — omit when unbound — was
    // rejected precisely because silence is not the goal; truth is.
    const withCli = OPERATIONS.filter(
      (operation) => spellingsFor(operation, bindingsFor(operation)).cli !== undefined,
    );
    expect(withCli.length).toBe(CLI_BOUND.size);

    const withMcp = OPERATIONS.filter(
      (operation) => spellingsFor(operation, bindingsFor(operation)).mcp !== undefined,
    );
    expect(withMcp.length).toBe(MCP_TOOL_NAMES.size);
  });
});

describe("an operation bound to two commands advertises one of them, predictably", () => {
  it("prefers the first in table order", () => {
    // `get_setting` is bound twice — `config get` and `config describe`.
    // Both dispatch to it, so both are true; this pins *which* is
    // advertised so the answer cannot change with table order alone.
    const bound = COMMANDS.filter((command) => command.operation === "get_setting").map(
      (command) => `standup ${command.noun} ${command.verb}`,
    );
    expect(bound).toContain("standup config get");
    expect(bound.length).toBeGreaterThan(1);
    expect(spellingsFor("get_setting", bindingsFor("get_setting")).cli).toBe("standup config get");
  });
});

describe("the two faults that produced the original defect", () => {
  it("does not spell a command as <verb> <noun>", () => {
    // The inverted grammar, which made 53 of 54 bound commands wrong while
    // looking entirely plausible. `get_item` is the canonical instance.
    const { cli } = spellingsFor("get_item", bindingsFor("get_item"));
    expect(cli).toBe("standup item get");
    expect(cli).not.toBe("standup get item");
  });

  it("does not advertise a command for an operation with no verb", () => {
    // The row's named case. `reparent_item` advertised `standup reparent
    // item`; no such verb is implemented.
    expect(CLI_BOUND.has("reparent_item")).toBe(false);
    expect(spellingsFor("reparent_item", bindingsFor("reparent_item")).cli).toBeUndefined();
  });

  it("does not advertise an mcp tool for an operation waived off mcp", () => {
    // `backfill` is waived from both MCP adapters — an MCP tool list costs
    // context on every session — so it is not in `tools/list`.
    expect(MCP_TOOL_NAMES.has("backfill")).toBe(false);
    const spelling = spellingsFor("backfill", bindingsFor("backfill"));
    expect(spelling.mcp).toBeUndefined();
    // …and the command line, which does expose it, still gets its command.
    expect(spelling.cli).toBe("standup backfill run");
  });

  it("does not advertise a folded operation as a tool of its own", () => {
    // `loop_close` is reached through `loop {action: "close"}`. It is not a
    // tool, and advertising it as one sent sessions calling `loop_close`
    // and getting nothing.
    expect(FOLDED_INTO.get("loop_close")).toBe("loop");
    expect(MCP_TOOL_NAMES.has("loop_close")).toBe(false);
    expect(spellingsFor("loop_close", bindingsFor("loop_close")).mcp).toBeUndefined();
    // `loop` itself is the tool, and is advertised.
    expect(spellingsFor("loop", bindingsFor("loop")).mcp).toBe("loop");
  });
});

describe("a refusal never points at a call the reader cannot make", () => {
  it("gives a cli reader the mcp spelling when no verb exists", () => {
    // `describe_tool` has no command-line verb, and two refusal paths point
    // at it by name, so a derived spelling would hand a CLI caller
    // `standup describe tool` — a second invented name, inside the message
    // meant to rescue them from the first.
    expect(CLI_BOUND.has("describe_tool")).toBe(false);
    const pointer = invocationWithArgumentFor(
      "describe_tool",
      "create_item",
      "cli",
      bindingsFor("describe_tool"),
    );
    expect(pointer).not.toContain("standup");
    expect(pointer).toBe('`describe_tool("create_item")`');
  });

  it("gives an mcp reader the cli spelling when the tool is waived", () => {
    // The mirror case: an operation the command line has and MCP does not.
    // Naming a real command on another surface beats naming an absent tool
    // on this one.
    expect(MCP_TOOL_NAMES.has("backfill")).toBe(false);
    expect(invocationFor("backfill", "mcp", bindingsFor("backfill"))).toBe(
      "`standup backfill run`",
    );
  });

  it("names both surfaces when the reader's surface is unknown and both are bound", () => {
    expect(invocationFor("get_item", undefined, bindingsFor("get_item"))).toBe(
      "`get_item` (or `standup item get` on the command line)",
    );
  });

  it("names only what exists when the surface is unknown and one is unbound", () => {
    // Not "both, one of them invented": an unbound surface contributes
    // nothing rather than a guess.
    expect(invocationFor("reparent_item", undefined, bindingsFor("reparent_item"))).toBe(
      "`reparent_item`",
    );
  });
});
