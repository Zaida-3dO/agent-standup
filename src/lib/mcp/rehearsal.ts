// Rehearsal unwrapping for the MCP write tools. See MILESTONES.md #32
// ("MCP write tools: create, update, transition, complete") and
// `../service/operations/rehearsal-rollback.ts`'s own header for the
// mechanism this wraps.
//
// ── The problem ──────────────────────────────────────────────────────────
//
// `transition_item`'s `dryRun` branch always throws `RehearsalRollback`,
// even on an *allowed* preview — that throw is what forces the transaction
// to abandon anything a guard wrote while merely being asked (see that
// class's own doc). The web API's transition route
// (`src/app/api/items/[id]/transition/route.ts`) catches exactly that class
// and answers 200 with `{ outcome }`; every other thrown value still goes
// through the ordinary error mapping.
//
// The MCP core (`./server.ts`) has no equivalent catch. `callTool` treats
// any throw as a rejection (`toolRejection`), so an unwrapped dry-run call
// would render to the agent as `isError: true` with `code: "internal"` —
// discarding exactly the "would this be allowed" answer §18 promises
// `transition`'s `dry_run` delivers, and doing so silently: the call still
// "succeeds" in the sense that nothing throws past the MCP layer, it just
// reports the wrong thing.
//
// ── The fix, and where it lives ──────────────────────────────────────────
//
// Wrap the `ServiceCall` handed to the MCP core, once, at the mount point —
// the same shape the web API route already takes, applied at the layer
// that plays the same role for MCP. This is deliberately *not* a change to
// `./server.ts` or `./tools.ts`: those are the transport-agnostic core
// every future MCP transport shares (`server.ts`'s own header — "neither
// [http nor stdio] touches a handler, because a handler cannot tell them
// apart"), and rehearsal unwrapping is not a property of *being* MCP, it is
// a property of *this one operation's* contract with whichever adapter
// calls it — the same reason the web API does its own unwrapping in its own
// route rather than in a shared response renderer. A future stdio mount
// (MILESTONES.md #84) wraps its own call the same way, exactly as it
// already wires its own transport stamp rather than reusing the HTTP one.
//
// This module knows nothing about transports, tool names or the MCP
// protocol — it only knows the one exception class every adapter that
// exposes `transition_item` has to recognise.
import { isRehearsalRollback } from "@/lib/service";
import type { ServiceCall } from "./server";

/**
 * Wraps `call` so a `RehearsalRollback` resolves as `{ outcome }` — the same
 * shape the web API's transition route answers with — instead of rejecting.
 *
 * Every other outcome passes through completely unchanged: a normal
 * success resolves as itself, and any other thrown value (an ordinary
 * `GuardRejectedError`, `InvalidInputError`, or anything else) rethrows so
 * the MCP core's own rejection rendering handles it unmodified. This
 * function contains no rule of its own — it recognises one exception class
 * and unwraps it, nothing else.
 */
export function withRehearsalUnwrapping(call: ServiceCall): ServiceCall {
  return async (name, input, options) => {
    try {
      return await call(name, input, options);
    } catch (error) {
      if (isRehearsalRollback(error)) {
        return { outcome: error.outcome };
      }
      throw error;
    }
  };
}
