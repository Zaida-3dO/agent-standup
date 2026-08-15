// Asking the server what to do about one event — `POST /api/hook`.
//
// This is an adapter, and it obeys the adapter rule (CLAUDE.md, "Working in
// this repo"): it resolves input, makes one call, and shapes the result. It
// reaches no database and holds no judgement — the judgement is
// `hook_decision` in the service layer.
//
// ── Every failure is the same value, on purpose ────────────────────────
//
// `undefined` for an unreachable server, a non-success status, and a body
// that is not JSON. They collapse because they have one consequence — the
// caller allows (`./decide.ts`, DECISIONS.md §16) — and enumerating them at
// the call site would eventually mean forgetting one.
//
// ── Only `block` blocks ────────────────────────────────────────────────
//
// A body whose `decision` this build has never seen reads as an allow, not
// as an error. Scripts are installed on machines and updated on their own
// schedule, so a server will routinely be ahead of one: adding a fourth
// decision value must not turn every call in an un-updated installation
// into a refusal. The field is read for the single string that refuses;
// everything else is a permission.
//
// Note what is deliberately not here: no retry. A hook runs on the critical
// path of every tool call, and a retry loop turns one unreachable server
// into a multi-second stall on every one of them. One attempt with a
// timeout, then whatever the caller does with no answer.

import type { ServerVerdict } from "./decide";
import type { HookEvent } from "./payload";
import { readSessionStatus } from "./enforcement";
import { readStopContext } from "./stop-catch";
import { readNudgeContext } from "./nudge";

/** The subset of `fetch` this adapter uses. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * How long to wait for an answer before giving up, in milliseconds.
 *
 * A `PreToolUse` call is *held* for this long in the worst case, so it is
 * the ceiling on how much an unreachable server can cost a session per tool
 * call. Short enough that an outage is an annoyance rather than a stall.
 */
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
 * The request carries what happened; the response carries what to do about
 * it. `toolResult` is sent on a `PostToolUse` so the server can evaluate
 * findings about *what a call produced* rather than only about what was
 * asked for — the server is the only party that can, and it is free to
 * ignore it.
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
          ...(event.toolResult === undefined ? {} : { toolResult: event.toolResult }),
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

    // A body that is not an object carries nothing readable. It is
    // `undefined` rather than an empty verdict so that the caller's
    // "unreachable" reason names it honestly — both allow, but only one of
    // them is a server that answered.
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;

    const rawDecision = property(body, "decision");
    const reason = property(body, "reason");
    const enforcement = readSessionStatus(property(body, "enforcement"));
    // Both advisory, and read after the decision: a malformed block in
    // either is dropped by its own reader and can never affect the verdict.
    const stop = readStopContext(property(body, "stop"));
    const nudge = readNudgeContext(property(body, "nudge"));

    return {
      // The one string that refuses. Everything else — including a value
      // this build does not recognise — is an allow.
      decision: rawDecision === "block" ? "block" : "allow",
      ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
      ...(enforcement === undefined ? {} : { enforcement }),
      ...(stop === undefined ? {} : { stop }),
      ...(nudge === undefined ? {} : { nudge }),
    };
  };
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}
