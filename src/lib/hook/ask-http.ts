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
import type { InterventionFinding } from "../interventions/types";

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
 * One `findings` entry, read defensively.
 *
 * `hook_decision`'s own response is trusted server output, but this reader
 * exists anyway for the same reason `readStopContext` and `readNudgeContext`
 * do not trust theirs either: a script is installed on a machine and a
 * server can be ahead of it, so a field this build does not yet know about
 * — or one an older server never sent — must not throw the whole response
 * away. Only what every caller of `buildCaptures` actually reads is
 * required (`id`, `level`, `phase`, `messages.plain`); a malformed entry is
 * dropped rather than failing the batch, the same posture `readSpool` takes
 * with a torn line.
 */
function readFinding(value: unknown): InterventionFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const id = record.id;
  const level = record.level;
  const phase = record.phase;
  const messages = record.messages;
  const plain =
    typeof messages === "object" && messages !== null
      ? (messages as Record<string, unknown>).plain
      : undefined;
  const prominent =
    typeof messages === "object" && messages !== null
      ? (messages as Record<string, unknown>).prominent
      : undefined;

  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof level !== "string" || level.length === 0) return undefined;
  if (typeof phase !== "string" || phase.length === 0) return undefined;
  if (typeof plain !== "string") return undefined;

  return {
    id,
    // `source` and `audience` are not read by anything on this side of the
    // wire — `buildCaptures` never asks for either — so they are carried
    // through when present rather than invented when absent. A cast rather
    // than a validated enum: an unrecognised value here changes nothing a
    // capture writes, so rejecting the whole finding over it would lose
    // real data to protect a property nobody reads.
    source: (typeof record.source === "string" ? record.source : "builtin") as never,
    phase: phase as never,
    audience: (typeof record.audience === "string" ? record.audience : "agent") as never,
    level: level as never,
    timing: (typeof record.timing === "string" ? record.timing : "immediate") as never,
    messages: { plain, prominent: typeof prominent === "string" ? prominent : plain },
  };
}

/** `findings`, read defensively. `undefined` for anything that is not an array. */
function readFindings(value: unknown): readonly InterventionFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings: InterventionFinding[] = [];
  for (const entry of value) {
    const finding = readFinding(entry);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
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
    // Advisory in the same sense: `hook_decision` always returns `findings`
    // (present-but-empty when nothing triggered), and nothing about them
    // can change `decision` — they exist so a caller can record what fired,
    // not to be consulted here.
    const findings = readFindings(property(body, "findings"));

    return {
      // The one string that refuses. Everything else — including a value
      // this build does not recognise — is an allow.
      decision: rawDecision === "block" ? "block" : "allow",
      ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
      ...(enforcement === undefined ? {} : { enforcement }),
      ...(stop === undefined ? {} : { stop }),
      ...(nudge === undefined ? {} : { nudge }),
      ...(findings === undefined ? {} : { findings }),
    };
  };
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}
