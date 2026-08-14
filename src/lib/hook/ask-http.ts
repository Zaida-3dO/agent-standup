// Asking the server for a verdict — `POST /hook` (SCHEMA.md §19, "The dumb
// pipe. Sends event type, session, tool, command. Returns allow/deny for
// guarded patterns, or nudge text, or nothing.").
//
// This is an adapter, and it obeys the adapter rule (CLAUDE.md, "Working in
// this repo"): it resolves input, makes one call, and shapes the result. It
// reaches no database and holds no judgement — the judgement is
// `hook_decision` in the service layer, reached through the route that
// row #41 shipped.
//
// ── Every failure is the same value, on purpose ────────────────────────
//
// `undefined` for an unreachable server, a non-success status, a body that
// is not JSON, and a body whose `decision` this build does not recognise.
// They collapse because they have one consequence — the caller denies
// (`./decide.ts`) — and enumerating them at the call site would eventually
// mean forgetting one and letting it reach the success branch. The reason a
// caller *needs* is "no answer"; which flavour of no answer is a
// troubleshooting detail, and troubleshooting detail that can flip a deny
// into an allow by being handled inattentively is not worth its cost.
//
// Note what is deliberately not here: no retry. A hook runs on the critical
// path of every guarded tool call, and a retry loop turns one unreachable
// server into a multi-second stall on every one of them. One attempt with a
// timeout, then deny — which the agent can act on immediately.

import type { ServerVerdict } from "./decide";
import type { HookEvent } from "./payload";
import { readRulesFromResponse } from "./rules-cache";
import { readSessionStatus } from "./enforcement";

/** The subset of `fetch` this adapter uses. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** How long to wait for a verdict before giving up and denying, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

export interface AskHttpOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  /** Creates the abort signal for the timeout. Injected so the timeout is testable. */
  readonly timeoutSignal?: (ms: number) => AbortSignal | undefined;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Builds the `askServer` function `runHook` takes.
 *
 * The response is read for three things, in decreasing order of how much
 * this build depends on them: the decision (required — its absence is "no
 * answer"), the session enforcement (optional; the row that produces it is
 * later), and a fresh rule set (optional; it is how the cache is refreshed
 * without a second request).
 *
 * **`ask` from the server is read as a deny.** The service layer's three
 * outcomes include `ask`, meaning "a rule must decide" — but by the time the
 * route has answered, the deciding is done, so an `ask` coming back is a
 * server that did not resolve the question it was asked. Treating it as
 * anything softer than a deny would make "the server was unsure" the one
 * kind of uncertainty this hook permits.
 */
export function createHttpAsk({
  baseUrl,
  fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutSignal = defaultTimeoutSignal,
}: AskHttpOptions) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/hook`;

  return async function askServer(event: HookEvent): Promise<ServerVerdict | undefined> {
    const signal = timeoutSignal(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventType: event.eventType,
          sessionId: event.sessionId,
          ...(event.tool === undefined ? {} : { tool: event.tool }),
          ...(event.command === undefined ? {} : { command: event.command }),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return undefined;
    }

    if (!response.ok) return undefined;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }

    const decision = property(body, "decision");
    if (decision !== "allow" && decision !== "deny" && decision !== "ask") return undefined;

    const reason = property(body, "reason");
    const rules = readRulesFromResponse(body);
    const enforcement = readSessionStatus(property(body, "enforcement"));

    return {
      decision: decision === "allow" ? "allow" : "deny",
      ...(typeof reason === "string" && reason.length > 0
        ? { reason }
        : decision === "ask"
          ? {
              reason:
                "the server did not resolve this command to allow or deny, so the hook denies it",
            }
          : {}),
      ...(rules === undefined ? {} : { rules }),
      ...(enforcement === undefined ? {} : { enforcement }),
    };
  };
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}
