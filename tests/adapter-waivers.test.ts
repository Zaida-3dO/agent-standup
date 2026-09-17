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
import { FOLDED_INTO, reachableOnMcp } from "@/lib/service/describe/reachability";
import { FOLD_ACTIONS } from "@/lib/service/describe/fold-actions";
import { narrowerCallFor } from "@/lib/service/response-size";
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
    //
    // **Why this list is written down when the other two corpora are
    // derived.** A guard's refusal text prescribes a remedy in prose, for a
    // reader: `deferral.follow_up_must_be_blocked` ends "Move it to the same
    // parent as this item" and names no operation at all. There is no token
    // to scan for -- deriving this corpus would mean matching English
    // against a tool list, which fails in both directions. So the pairing of
    // "guard that prescribes" to "operation that performs" is a judgement,
    // recorded here with the guard that makes each one load-bearing, and the
    // cost of that choice is stated plainly: adding a guard whose refusal
    // names a new remedy will NOT fail here until someone adds the row.
    const AGENT_REMEDIATION_OPERATIONS = [
      // `kill.ownership` refuses a machine-wide kill and its refusal text
      // names `register_process` as the way to make the call succeed
      // (`@/lib/kill/ownership`); the other two are how that registry is
      // read and closed.
      "register_process",
      "end_process",
      "list_processes",
      // `deferral.follow_up_must_be_blocked` (`@/lib/service/guards/deferral`)
      // refuses a completion whose linked follow-up sits underneath the
      // completing item and ends: "Move it to the same parent as this item."
      // `reparent_item` is the only operation that performs that move, and
      // the guard runs inside `complete_item` -- an operation MCP exposes.
      // So an agent can be refused over MCP, told exactly what to do, and
      // have no MCP tool that does it. It was waived here for a year on the
      // reasoning that reparenting is rare person-driven surgery; that is
      // true of a person tidying a board and false of the agent this guard
      // is talking to, which is what made the waiver wrong.
      "reparent_item",
      // `guard.response_too_large` (`@/lib/service/response-size`) refuses
      // `get_item_detail` on an item whose payload will not fit, and its
      // advice names `get_item_history` as the way to reach that item's
      // notes and checkpoints. Nothing else returns them: `get_item`,
      // `my_work` and `progress_report` -- the three the waiver's own
      // reason claimed covered this -- return no note or checkpoint body
      // for an arbitrary item at all, so the waiver's operative claim was
      // simply false. It was waived as "a user-interface read" backing the
      // Activity tab, which is true of one caller and not of the agent the
      // refusal is addressed to. Two sessions reported the dead end within
      // a day; one tried six routes and found nothing.
      "get_item_history",
      // Same refusal, same advice, the other half of it: `get_item_artifacts`
      // is what reaches the artifacts, and on a long-lived item those are
      // frequently the whole reason the response did not fit.
      "get_item_artifacts",
    ];
    // ── Reachability, not non-waiver ──────────────────────────────────
    //
    // This assertion used to read `expect(isWaived(...)).toBe(false)` on
    // each MCP adapter, and while every remedy was its own tool the two
    // said the same thing. They stop saying the same thing once a remedy
    // can be FOLDED: what has to be true is that the capability is
    // reachable by the refused caller, and non-waiver of a name was only
    // ever the way to express that. A remedy folded into an exposed tool is
    // still reachable — the fold dispatches to the operation that
    // implements it and returns its refusal object unedited — and the
    // advice moves to the folded spelling in the same commit, because
    // `advice.ts`'s `unreachable` class fails the build otherwise.
    //
    // **This is a trade and it is conceded rather than talked away.** A
    // name check is blind to two cases this one catches — a fold target
    // that does not exist, and a fold chain whose terminal tool is itself
    // waived — and stricter in exactly one: an operation waived and folded
    // into an exposed tool, which a name check refuses and this one
    // permits. See `reachableOnMcp`'s header for the full case table.
    //
    // The comment below asks that a failure here be re-argued rather than
    // silently kept. That is what this is: the argument is that
    // `get_item_history` and `get_item_artifacts` remain reachable through
    // `read_item`, so the capability the two stranded sessions lacked is
    // present and only its spelling moved. The conceded case is closed by
    // the cross-check in the test that follows, which is what stops "folded
    // into an exposed tool" from being taken on trust.
    for (const operation of AGENT_REMEDIATION_OPERATIONS) {
      expect(reachableOnMcp(operation), `${operation} is not reachable by an MCP caller`).toBe(
        true,
      );
    }
  });

  it("every folded operation is reachable through an action its fold declares", () => {
    // The cross-check that closes the loosening above.
    //
    // `reachableOnMcp` resolves a waived operation through `FOLDED_INTO`,
    // which is a name-to-name map and nothing more. Nothing in it asserts
    // the fold actually EXPOSES AN ACTION reaching the folded behaviour:
    // `FOLDED_INTO` and `FOLD_ACTIONS` are independent tables, written in
    // different files, with no relationship the compiler can see. So
    // without this, an operation could be reported reachable through a fold
    // that has no action for it — a waiver justified by a door that does
    // not open.
    //
    // Note what this does NOT do, deliberately: it does not check that the
    // right action reaches the right delegate. That is not assertable from
    // two maps, because both are declarations — the only way to know is to
    // run the fold and see. `tests/fold-forwarding-names.test.ts` does
    // exactly that and asserts every `FOLDED_INTO` key is OBSERVED being
    // reached. This test is the cheap structural half; that one is the
    // behavioural half, and the pair is what makes the concession safe.
    expect(FOLDED_INTO.size).toBeGreaterThan(0);

    for (const [folded, tool] of FOLDED_INTO) {
      const fold = FOLD_ACTIONS.get(tool);
      expect(fold, `${tool} folds ${folded} but declares no actions`).toBeDefined();
      expect(fold!.actions.length, `${tool} declares an empty action list`).toBeGreaterThan(0);
      // And the tool a caller is redirected to is one they actually hold.
      // A fold target waived off MCP would make every operation folded into
      // it unreachable while each looked individually accounted for.
      expect(reachableOnMcp(tool), `${tool} is itself unreachable on MCP`).toBe(true);
    }
  });

  it("reports an operation waived off every MCP adapter and folded into nothing as unreachable", () => {
    // **The negative control, and it is load-bearing rather than tidy.**
    //
    // Every operation the assertions above check is, by construction, one
    // that IS reachable — so `reachableOnMcp` hardcoded to `return true`
    // passes all of them. Measured: that mutation left the whole file
    // green. An assertion that only ever asks for `true` cannot tell a
    // working predicate from a constant, which is the same hollowness this
    // PR's first commit removed from the forwarding guard.
    //
    // `backfill` is the right subject precisely because it is the dull
    // case: waived from both MCP transports, in `FOLDED_INTO` nowhere, and
    // waived for a reason (per-session tool-list cost) that has nothing to
    // do with folding and so will not be disturbed by this PR or the next
    // one. `readiness` is the same shape and is checked alongside it, so a
    // single waiver being edited does not quietly remove the control.
    expect(reachableOnMcp("backfill")).toBe(false);
    expect(reachableOnMcp("readiness")).toBe(false);

    // And the premises, so this cannot pass for the wrong reason — a typo'd
    // operation name is unreachable too, and would satisfy the two lines
    // above while checking nothing.
    expect(isWaived("mcp_http", "backfill")).toBe(true);
    expect(isWaived("mcp_stdio", "backfill")).toBe(true);
    expect(FOLDED_INTO.has("backfill")).toBe(false);
    expect(OPERATION_NAMES).toContain("backfill");
  });

  it("keeps the bounded-read remedies reachable for the guard that prescribes them", () => {
    // The companion to the two rows added to AGENT_REMEDIATION_OPERATIONS
    // above, and it fails for a different cause on purpose: restore either
    // waiver and the test above fails; reword the advice so it stops
    // naming these tools and this one fails, which is the signal that the
    // rows above may have stopped being load-bearing and should be
    // re-argued rather than silently kept.
    //
    // Read out of `response-size.ts` rather than restated here, so this
    // checks the text a refused caller is actually shown.
    const adviceSource = readFileSync(
      path.join(repoRoot(), "src/lib/service/response-size.ts"),
      "utf-8",
    );
    const collapsed = adviceSource.replace(/"\s*\+\s*"/g, "");

    const detailAdvice = narrowerCallFor("get_item_detail");
    expect(detailAdvice).toBeDefined();
    // The two remedies that reach the data, named in the spelling a caller
    // holds. Every route the advice names other than these answers a
    // different question than the one the refused caller asked: the loops,
    // the body and the slim record each shrink a different part of the
    // payload and none of them returns an artifact or a note body at all.
    //
    // **The tools are named by their folded spelling, which is the same
    // assertion and not a weaker one.** What has to be true is that a
    // refused caller can follow the advice; the advice has to name a call
    // they can make, and after the fold that call is `read_item` with an
    // action. Asserting the pre-fold names here would pin the advice to
    // tools no MCP caller can call, which is the defect this test exists to
    // prevent rather than a stricter form of preventing it.
    expect(detailAdvice).toContain('read_item` with `action: "artifacts"');
    expect(detailAdvice).toContain('read_item` with `action: "history"');
    // Named with the parameter that makes each useful, not by name alone:
    // the history read returns a slim ledger without `full`, which is not
    // the note text the caller was refused while reading.
    expect(detailAdvice).toContain("full: true");
    expect(collapsed).toContain('action: \"artifacts\"');

    // And the capability is genuinely reachable, which is the half a string
    // assertion cannot see. Asserted as REACHABILITY rather than as
    // non-waiver, for the reason `reachableOnMcp`'s header gives: what the
    // two stranded sessions lacked was a route to their item's notes and
    // artifacts, and a route through a fold is a route. The tool they are
    // reached through is asserted callable too, so this cannot pass by the
    // fold target itself having gone off the surface.
    for (const operation of ["get_item_artifacts", "get_item_history"]) {
      expect(reachableOnMcp(operation), `${operation} is unreachable on MCP`).toBe(true);
    }
    expect(isWaived("mcp_http", "read_item")).toBe(false);
    expect(isWaived("mcp_stdio", "read_item")).toBe(false);
  });

  it("keeps the move remedy reachable for the guard that actually prescribes it", () => {
    // The test above asserts `reparent_item` is exposed. This one asserts
    // the *reason* it has to be, by reading the guard's own refusal text
    // rather than trusting a comment about it. The two fail for different
    // causes on purpose: delete the waiver row and the test above fails;
    // reword the guard so it stops prescribing a move and this one fails,
    // which is the signal that the entry above may have stopped being
    // load bearing and should be re-argued rather than silently kept.
    const guardSource = readFileSync(
      path.join(repoRoot(), "src/lib/service/guards/deferral.ts"),
      "utf-8",
    );

    // The refusal is assembled from concatenated string literals, so the
    // sentence does not exist contiguously in the source. Collapsing the
    // quote-plus-operator seams is what lets the prose be matched as the
    // reader sees it.
    const collapsed = guardSource.replace(/"\s*\+\s*"/g, "");
    expect(collapsed).toContain("Move it to the same parent as this item.");

    // ...and the operation that performs that move is on the surface the
    // refused agent is using. This is the whole invariant in one line.
    expect(isWaived("mcp_http", "reparent_item")).toBe(false);
    expect(isWaived("mcp_stdio", "reparent_item")).toBe(false);

    // The guard reaches agents through `complete_item`, which MCP exposes.
    // If that ever stopped being true the refusal could not reach an MCP
    // caller and the coupling would not matter.
    expect(isWaived("mcp_http", "complete_item")).toBe(false);
  });
});

describe("isWaived / waiversFor / exposedOperations", () => {
  it("reports a waived pair and nothing else", () => {
    expect(isWaived("mcp_http", "backfill")).toBe(true);
    expect(isWaived("mcp_stdio", "backfill")).toBe(true);
    expect(isWaived("http", "backfill")).toBe(false);
    expect(isWaived("cli", "backfill")).toBe(false);
    // `transition_item` is the sentinel for "still exposed".
    //
    // **This is its second move, and the second one is different in kind
    // from the first.** The role was originally `create_task`'s; it went to
    // `checkpoint` when `create_task` was folded into `create_work`, under
    // the rule that a sentinel has to be a tool no planned fold will ever
    // touch or it stops being a positive control and becomes another thing
    // to edit. `checkpoint` is now folded into `record`, so that rule has
    // cost two edits and been satisfied by intent both times.
    //
    // `transition_item` satisfies it MECHANICALLY, which is why this move
    // is terminal rather than the next one in a series. It is one of the
    // two operations in `GUARD_RUNNING_OPERATIONS` above — the only
    // registered operations reaching `runGuards` through the state machine
    // — and the §22-bound assertion there refuses a waiver naming either.
    // So waiving `transition_item` off MCP fails this file whatever anyone
    // intends, rather than relying on a future planner reading a comment.
    // A positive control protected by an assertion is a better positive
    // control than one protected by a request.
    //
    // It is also out of scope for folding on the merits: six flat fields,
    // zero contract rules, and folding it into `complete_item` or
    // `update_item` would infer intent from which fields arrived — the
    // bound every fold here has to clear, and the reason a tool that
    // guesses its subject from the shape of its input has no place on this
    // surface.
    expect(isWaived("mcp_http", "transition_item")).toBe(false);
    expect(isWaived("mcp_stdio", "transition_item")).toBe(false);
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
    const all = [{ name: "backfill" }, { name: "transition_item" }];
    expect(exposedOperations("mcp_http", all).map((o) => o.name)).toEqual(["transition_item"]);
    expect(exposedOperations("http", all).map((o) => o.name)).toEqual([
      "backfill",
      "transition_item",
    ]);
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
    expect(tools.map((t) => t.name)).toContain("transition_item");
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
    expect(registered).toContain("transition_item");
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
