// Adapter waivers (SCHEMA.md §22's fourth conformance assertion).
//
// A waiver is a deliberate gap in an adapter's surface. These tests are what
// make it *bounded*: that it names a real adapter and a real operation, that
// it carries an argument rather than a shrug, and that the operation it
// waives is one §22's rule actually permits to be waived.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTER_NAMES } from "@/lib/adapters/registry";
import {
  ADAPTER_WAIVERS,
  exposedOperations,
  isWaived,
  waiversFor,
  waiversNameRegisteredAdapters,
} from "@/lib/adapters/waivers";
import { listOperations, OPERATION_NAMES } from "@/lib/service";
import { createMcpServer } from "@/lib/mcp/server";
import { toolsFromOperations } from "@/lib/mcp/tools";

describe("the waiver list", () => {
  it("names only registered adapters", () => {
    expect(waiversNameRegisteredAdapters()).toBe(true);
    for (const waiver of ADAPTER_WAIVERS) {
      expect(ADAPTER_NAMES).toContain(waiver.adapter);
    }
  });

  it("names only registered operations — a waiver for nothing is a stale waiver", () => {
    for (const waiver of ADAPTER_WAIVERS) {
      expect(OPERATION_NAMES).toContain(waiver.operation);
    }
  });

  it("carries a real reason on every entry, not a placeholder", () => {
    // §22: waivers "live in one reviewed file with a reason each". A reason
    // short enough to be a shrug is not one.
    for (const waiver of ADAPTER_WAIVERS) {
      expect(waiver.reason.length).toBeGreaterThan(40);
    }
  });

  it("waives no operation a registered guard can reject — §22's bound", () => {
    // The bound exists so an adapter cannot decline to expose the
    // operations that are hard to get right and then pass the comparison
    // assertions vacuously.
    //
    // Derived rather than hand-listed. A permit list naming each waived
    // operation grows with the waiver list and is maintained by the same
    // edit, so it stops being independent evidence the moment the list is
    // long — it becomes a second copy of the thing it checks, and the
    // honest way to satisfy it is to append to both. What actually bounds
    // a waiver is *structural*: a registered guard runs only inside the
    // state machine's `runGuards`, and the only *registered operations*
    // that reach it are the two below. (`rehearsal-rollback.ts` also calls
    // the transition path but declares no operation, so no adapter can
    // expose or waive it.) An operation that cannot reach a transition
    // cannot be refused by a guard, so waiving it loses no guard-coverage
    // case — which is exactly what §22's bound protects.
    //
    // Adding a third guard-running operation and waiving it from MCP
    // fails here, which is the behaviour being bought.
    const GUARD_RUNNING_OPERATIONS = new Set(["transition_item", "complete_item"]);
    for (const waiver of ADAPTER_WAIVERS) {
      expect(GUARD_RUNNING_OPERATIONS.has(waiver.operation)).toBe(false);
    }
  });

  it("waives nothing off its last remaining surface", () => {
    // -- The invariant ------------------------------------------------
    //
    // A waiver says "not here, reach it elsewhere". That sentence is only
    // true while an elsewhere exists. Waive an operation from every MCP
    // transport when MCP is the only surface carrying it and the
    // operation becomes unreachable by anyone -- which is not a narrowed
    // surface, it is a removed capability wearing a waiver's clothes, and
    // nothing about a waiver's shape says so.
    //
    // This is a *different* rule from the two above it. The guard-coverage
    // bound is about which refusals stay exercised; the remediation rule
    // is about an operation a refusal *names*. Neither notices an
    // operation that simply has nowhere else to be -- which is how three
    // of them came close to being waived at once, each individually
    // plausible, each described in its own reason as remaining reachable
    // on surfaces that do not carry it.
    //
    // -- Why the corpus is derived and not written down ----------------
    //
    // The same reasoning the guard-coverage test gives for deriving its
    // own corpus applies with more force here: a hand-written list of
    // which operations have an HTTP route is a second copy of the route
    // tree, maintained by a different edit than the one that adds a
    // route, and its failure mode is silent under-reporting -- an
    // operation whose route was deleted still looks reachable. So both
    // surfaces are read from the source that defines them.
    //
    // **A caution about how NOT to check this.** The obvious corpus is
    // `src/lib/http-routes.generated.ts`, and it is the wrong one: it
    // lists route *paths*, not the operations behind them, so a search
    // for an operation name in it finds nothing for every operation --
    // including ones that plainly have routes. A check built on it would
    // report the whole surface as stranded, or, calibrated against that,
    // report nothing as stranded ever. The corpora below were each
    // sanity-checked against operations known to be reachable before
    // being trusted, and `SURFACE_CONTROLS` keeps that check running.
    const httpOperations = operationsCalledByHttpRoutes();
    const cliOperations = operationsBoundToCliVerbs();

    // -- The controls --------------------------------------------------
    //
    // A derivation that silently returned nothing would pass this test
    // vacuously: with no operation reachable anywhere, the loop below
    // still finds nothing stranded only because it never looks. These fix
    // known-reachable operations in place, so a scan that breaks -- a
    // renamed directory, a changed call shape -- fails loudly here rather
    // than quietly wherever it is used.
    // A corpus that is too WIDE is as bad as one that is too narrow: an
    // operation wrongly believed reachable can be waived off its last real
    // surface with this test still green. `describe_tool` is the control
    // for that direction -- it is deliberately MCP-only, with no route and
    // no verb -- so it must be absent from both corpora. It is also the
    // operation the build facts were rehomed onto, which makes a false
    // "reachable" here directly dangerous.
    expect(httpOperations.has("describe_tool")).toBe(false);
    expect(cliOperations.has("describe_tool")).toBe(false);
    // `kill_guard` guards the same direction for the command line
    // specifically. It appears in `src/lib` -- the hook reaches it -- but is
    // bound to no verb, so a scan pointed one directory too high sweeps it
    // in along with two dozen others. That widening is not hypothetical:
    // it would also wrongly mark `poll` CLI-reachable, and `poll` is waived
    // here. Mutation testing confirmed this assertion is what catches it.
    expect(cliOperations.has("kill_guard")).toBe(false);
    // ...and things with a real route and a real verb are present, so the
    // assertions above cannot be satisfied by an empty corpus.
    expect(httpOperations.has("backfill")).toBe(true);
    expect(cliOperations.has("backfill")).toBe(true);

    const SURFACE_CONTROLS = [
      // A read with a route and no CLI verb.
      { operation: "get_board", http: true, cli: false },
      // A write with both.
      { operation: "note", http: true, cli: true },
      // A read whose only non-MCP surface is the command line -- the
      // shape that makes a waiver legal with no HTTP route at all.
      { operation: "service_info", http: false, cli: true },
      // Reachable through a route whose `service.call` literal sits on
      // the line *after* the call, so a scan reading one line at a time
      // misses it. This is the specific way the HTTP corpus can
      // under-report while still looking populated.
      { operation: "register_session", http: true, cli: true },
    ] as const;
    for (const control of SURFACE_CONTROLS) {
      expect({
        operation: control.operation,
        http: httpOperations.has(control.operation),
        cli: cliOperations.has(control.operation),
      }).toEqual({ operation: control.operation, http: control.http, cli: control.cli });
    }

    // -- The assertion -------------------------------------------------
    //
    // Checked across adapters rather than per waiver, because a waiver on
    // one MCP transport and not the other still leaves the operation
    // reachable. Only an operation waived by *every* MCP adapter, with no
    // route and no verb, is stranded.
    const mcpAdapters = ADAPTER_NAMES.filter((adapter) => adapter !== "http" && adapter !== "cli");
    const stranded: string[] = [];
    for (const operation of new Set(ADAPTER_WAIVERS.map((waiver) => waiver.operation))) {
      if (httpOperations.has(operation) || cliOperations.has(operation)) continue;
      if (mcpAdapters.every((adapter) => isWaived(adapter, operation))) stranded.push(operation);
    }
    expect(stranded).toEqual([]);
  });

  it("waives nothing that is an agent's only route to a documented remediation", () => {
    // A waiver is legal under §22 and still wrong if it removes the one
    // surface an agent was told to use. The kill guard refuses a
    // machine-wide kill and its refusal text names `register_process` as
    // the way to make the call succeed (`@/lib/kill/ownership`); the
    // other two process operations are how that registry is read and
    // closed. Waiving any of them from MCP would leave a refusal message
    // pointing at a tool the refused agent cannot call.
    const AGENT_REMEDIATION_OPERATIONS = ["register_process", "end_process", "list_processes"];
    for (const operation of AGENT_REMEDIATION_OPERATIONS) {
      expect(isWaived("mcp_http", operation)).toBe(false);
      expect(isWaived("mcp_stdio", operation)).toBe(false);
    }
  });
});

describe("isWaived / waiversFor / exposedOperations", () => {
  it("reports a waived pair and nothing else", () => {
    expect(isWaived("mcp_http", "backfill")).toBe(true);
    expect(isWaived("mcp_stdio", "backfill")).toBe(true);
    expect(isWaived("http", "backfill")).toBe(false);
    expect(isWaived("cli", "backfill")).toBe(false);
    // `checkpoint` is the sentinel for "still exposed": it is one of the
    // most-called agent-facing tools and is deliberately not waived. It took
    // this role from `create_task`, which is now reached through the folded
    // `create_work` tool and waived off MCP with the other two creates — a
    // sentinel has to be a tool no planned fold will ever touch, or it stops
    // being a positive control and becomes another thing to edit.
    expect(isWaived("mcp_http", "checkpoint")).toBe(false);
    expect(isWaived("mcp_stdio", "checkpoint")).toBe(false);
    expect(isWaived("mcp_http", "create_item")).toBe(true);
    // The folded-away creates and loop verbs are waived on MCP only.
    expect(isWaived("mcp_http", "create_task")).toBe(true);
    expect(isWaived("mcp_http", "loop_add")).toBe(true);
    expect(isWaived("http", "create_task")).toBe(false);
    expect(isWaived("cli", "loop_add")).toBe(false);
    expect(isWaived("mcp_http", "get_crew_name")).toBe(true);
    expect(isWaived("mcp_stdio", "get_crew_name")).toBe(true);
    expect(isWaived("http", "get_crew_name")).toBe(false);
    expect(isWaived("cli", "get_crew_name")).toBe(false);
    // Readiness is an infrastructure probe, not an agent tool: waived from
    // both MCP surfaces, exposed on the two that cost nothing per session.
    expect(isWaived("mcp_http", "readiness")).toBe(true);
    expect(isWaived("mcp_stdio", "readiness")).toBe(true);
    expect(isWaived("http", "readiness")).toBe(false);
    expect(isWaived("cli", "readiness")).toBe(false);
  });

  it("groups waivers by adapter", () => {
    const mcpHttpWaived = waiversFor("mcp_http").map((w) => w.operation);
    // Grouping is what is under test, so: every entry returned is for this
    // adapter, the originals are still in it, and no operation is listed
    // twice — a duplicate would quietly double-count the surface reduction.
    for (const waiver of waiversFor("mcp_http")) expect(waiver.adapter).toBe("mcp_http");
    expect(mcpHttpWaived).toEqual(
      expect.arrayContaining(["backfill", "get_crew_name", "readiness"]),
    );
    expect(new Set(mcpHttpWaived).size).toBe(mcpHttpWaived.length);
    expect(waiversFor("mcp_http").length).toBe(waiversFor("mcp_stdio").length);
    expect(waiversFor("http")).toEqual([]);
  });

  it("filters a list down to what an adapter exposes", () => {
    const all = [{ name: "backfill" }, { name: "checkpoint" }];
    expect(exposedOperations("mcp_http", all).map((o) => o.name)).toEqual(["checkpoint"]);
    expect(exposedOperations("http", all).map((o) => o.name)).toEqual(["backfill", "checkpoint"]);
  });
});

describe("the MCP adapter honours its waiver", () => {
  it("does NOT advertise backfill or get_crew_name as a tool", async () => {
    // The whole reason for the waiver: an MCP tool list is sent to the
    // model on every session, so a one-shot bulk-import tool would spend
    // context permanently to be callable for minutes. Removing the filter
    // in createMcpServer puts it straight back into the list. `get_crew_name`
    // is waived for a different reason (naming is now a side effect of
    // register_session/claim), same mechanism.
    const tools = toolsFromOperations(exposedOperations("mcp_http", listOperations()));
    expect(tools.map((t) => t.name)).not.toContain("backfill");
    expect(tools.map((t) => t.name)).not.toContain("get_crew_name");
    expect(tools.map((t) => t.name)).toContain("checkpoint");
    // The folded tools are the ones MCP exposes: one loop tool with an
    // action field, one create tool with a required type field.
    expect(tools.map((t) => t.name)).toContain("create_work");
    expect(tools.map((t) => t.name)).toContain("loop");
    expect(tools.map((t) => t.name)).not.toContain("create_task");
    expect(tools.map((t) => t.name)).not.toContain("loop_add");
  });

  it("builds a server whose registered tools exclude the waived operation", async () => {
    // Reads the tools the SDK actually holds, rather than recomputing the
    // list this test is supposed to be checking. Deleting the
    // `exposedOperations` call in createMcpServer's default puts `backfill`
    // back into this set and fails here.
    const server = createMcpServer({
      call: async () => ({}),
      transport: "mcp-http",
      adapter: "mcp_http",
    });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toContain("checkpoint");
    expect(registered).toContain("create_work");
    expect(registered).toContain("loop");
    expect(registered).not.toContain("backfill");
    expect(registered).not.toContain("get_crew_name");
    // Everything else the registry holds IS exposed — the waiver is one
    // named gap, not a general shrinking of the surface.
    const expected = OPERATION_NAMES.filter((name) => !isWaived("mcp_http", name));
    expect(registered.sort()).toEqual([...expected].sort());

    await server.close();
  });
});

// -- Deriving what each surface actually carries -------------------------
//
// Both scans read the source that *defines* the surface, so adding a route
// or a verb makes an operation reachable here by the same edit that makes it
// reachable in the product -- there is no second list to remember to update.

/**
 * The real, git-tracked repo root -- deliberately NOT `import.meta.dirname`.
 * Under mutation testing the suite runs from a sandboxed, instrumented copy
 * of the tree, and a scan rooted on the test's own directory would read that
 * rewritten copy rather than the real source.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

/** Every TypeScript file under a directory, recursively. */
function sourceFilesUnder(relative: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
  };
  walk(path.join(repoRoot(), relative));
  return found;
}

/**
 * Operations reachable over HTTP, read from the route tree.
 *
 * A route is a thin shell over exactly one `service.call("<name>", ...)`, so
 * that call is what makes an operation reachable there. Matched across a
 * newline because several routes put the literal on the line after the call,
 * and a line-at-a-time scan silently misses those.
 *
 * The MCP transport's own route shell is skipped. It forwards whatever name
 * it is handed (`service.call(name, ...)`) rather than naming an operation,
 * so it describes no surface of its own. Skipping it is defence in depth
 * rather than load-bearing: the pattern requires a quoted literal, so the
 * shell contributes nothing even when read -- mutation testing confirmed
 * that removing this skip, widening the pattern to accept an unquoted
 * identifier, and doing both at once all leave every assertion passing,
 * because the only token such a match can yield is the parameter name
 * itself, which is not a registered operation. Both are kept so that
 * neither change alone can start counting forwarded calls.
 */
function operationsCalledByHttpRoutes(): Set<string> {
  const found = new Set<string>();
  const mcpShell = path.join("api", "mcp", "route.ts");
  for (const file of sourceFilesUnder("src/app/api")) {
    if (file.endsWith(mcpShell)) continue;
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/service\.call\(\s*"([a-z_]+)"/g)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

/**
 * Operations reachable from the command line, read from the verb tables.
 *
 * Every command is a descriptor naming the one operation it calls -- the
 * command layer has no surface of its own to add to -- so the `operation`
 * property is the definition of what the command line carries.
 */
function operationsBoundToCliVerbs(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFilesUnder("src/lib/cli")) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/operation:\s*"([a-z_]+)"/g)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}
