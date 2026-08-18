// Adapter waivers — the one reviewed file SCHEMA.md §22 asks for.
//
// §22's fourth conformance assertion is adapter completeness: every
// operation an adapter exposes maps to a registered service operation, and
// **any it deliberately does not expose carries a written waiver**. This is
// where those waivers live, with a reason each, so a gap is a decision on
// record rather than something a reader has to infer from an absence.
//
// **Waivers are bounded by construction, not by review attention.** §22
// states the bound: *no operation any registered guard can reject may be
// waived by an adapter that exposes any write operation* — otherwise an
// adapter could decline to expose the operations that are hard to get right
// and pass the comparison assertions vacuously. Every entry below has to
// satisfy that, and the reason field is where the argument is made.
import { ADAPTER_NAMES, type AdapterName } from "./registry";

export interface AdapterWaiver {
  readonly adapter: AdapterName;
  /** The operation this adapter deliberately does not expose. */
  readonly operation: string;
  /** Why. Printed in the conformance summary — a waiver with no argument is not one. */
  readonly reason: string;
}

/**
 * Every waiver, in one place.
 *
 * The MCP adapters waive `backfill` for a reason that is about MCP
 * specifically rather than about backfill being awkward: an MCP tool list
 * is sent to a model **on every session**, so every registered tool spends
 * context whether or not it is ever called. A one-shot bulk-import tool
 * that is disabled during normal operation would spend that budget
 * permanently to be callable during a window measured in minutes. HTTP and
 * the command line have no equivalent per-session cost — a route or a verb
 * that nobody invokes costs nothing — so they expose it.
 *
 * **Why this is a legal waiver under §22's bound.** The bound forbids
 * waiving an operation *a registered guard can reject*. `backfill` cannot
 * be rejected by a registered guard: it refuses a closed window with
 * `forbidden` and a malformed payload with `invalid_input`, and every
 * validation it performs is on its own schema (see `contract.ts`'s
 * `defaultArea`, which is validated there precisely so the area resolver's
 * guard can never fire inside this operation). So no guard-coverage case
 * is lost by MCP not exposing it, which is exactly what the bound protects.
 */
export const ADAPTER_WAIVERS: readonly AdapterWaiver[] = Object.freeze([
  {
    adapter: "mcp_http",
    operation: "backfill",
    reason:
      "An MCP tool list is sent to the model on every session, so every tool costs context " +
      "permanently. Backfill is a one-shot bulk load that is disabled during normal operation; " +
      "paying a per-session cost for a surface open for minutes is the wrong trade. It carries " +
      "no guard rejection, so §22's bound on waivers is satisfied. Reach it over HTTP or the " +
      "command line.",
  },
  {
    adapter: "mcp_stdio",
    operation: "backfill",
    reason:
      "Same as mcp_http — one MCP surface, two transports, and the per-session tool-list cost " +
      "is identical on both.",
  },
  {
    adapter: "mcp_http",
    operation: "get_crew_name",
    reason:
      "Naming is assigned server-side as a side effect of register_session and claim " +
      "(ensureNameForSession, @/lib/agent-names) — an agent never needs to call this " +
      "separately, so it has no business sitting in a tool list with a required sessionId " +
      "field the other agent-facing tools' schemas do not explain. It carries no guard " +
      "rejection (handOutName's only failure mode is an exhausted pool, mapped to a plain " +
      "conflict), so §22's bound on waivers is satisfied. Reach it over HTTP or the command " +
      "line for the rare caller that wants a name with no other side effect.",
  },
  {
    adapter: "mcp_stdio",
    operation: "get_crew_name",
    reason: "Same as mcp_http — one MCP surface, two transports, same reasoning.",
  },
  {
    adapter: "mcp_http",
    operation: "readiness",
    reason:
      "Readiness answers a question infrastructure asks — a deployment gate, a compose " +
      "condition, a load balancer — and its consumers reach it as an unauthenticated HTTP " +
      "probe, which is the one shape an MCP tool cannot be. An agent has no use for it: a " +
      "session is already talking to a server that answered, so the question is settled by " +
      "the time any tool could ask it. It carries no guard rejection — it runs one query and " +
      "reports counts — so §22's bound on waivers is satisfied.",
  },
  {
    adapter: "mcp_stdio",
    operation: "readiness",
    reason: "Same as mcp_http — one MCP surface, two transports, same reasoning.",
  },
]);

/** Whether `adapter` deliberately does not expose `operation`. */
export function isWaived(adapter: AdapterName, operation: string): boolean {
  return ADAPTER_WAIVERS.some(
    (waiver) => waiver.adapter === adapter && waiver.operation === operation,
  );
}

/** Every waiver for one adapter. */
export function waiversFor(adapter: AdapterName): readonly AdapterWaiver[] {
  return ADAPTER_WAIVERS.filter((waiver) => waiver.adapter === adapter);
}

/**
 * The operations `adapter` should expose, given a full list.
 *
 * Adapters that derive their surface from the operation registry call this
 * instead of the registry directly, so a waiver takes effect by being
 * declared rather than by each adapter remembering to honour it.
 */
export function exposedOperations<T extends { readonly name: string }>(
  adapter: AdapterName,
  operations: readonly T[],
): T[] {
  return operations.filter((operation) => !isWaived(adapter, operation.name));
}

/** Guards against a waiver naming an adapter that does not exist — checked by a test, not by hope. */
export function waiversNameRegisteredAdapters(): boolean {
  return ADAPTER_WAIVERS.every((waiver) => ADAPTER_NAMES.includes(waiver.adapter));
}
