// Sending a flush batch to the ingest — MILESTONES.md #88, the client half
// of #50's `POST /api/tool-calls`.
//
// This is an adapter and it obeys the adapter rule (CLAUDE.md, "Working in
// this repo"): it shapes one request, makes one call, and reduces the answer
// to a boolean. It reaches no database and holds no judgement about the
// telemetry it carries.
//
// ── Every failure is the same value, deliberately ──────────────────────
//
// `false` for an unreachable server, a non-success status, and a body that
// could not be read. Same collapse `./ask-http.ts` makes, for the same
// reason — they have exactly one consequence for the caller (keep the
// records, stop the flush) and a caller that had to enumerate them could
// forget one and treat it as success, which **deletes telemetry**. That is
// the worst outcome available here, because §10's history cannot be
// backfilled.
//
// The one asymmetry with `ask-http` worth knowing: an ask that fails denies
// a tool call, so its failure is loud by construction. A flush that fails
// is silent — the records simply stay spooled and are retried. That is the
// correct behaviour, and it is also why the *reason* matters more here than
// it looks: a permanently rejected batch (a client sending a shape the
// server refuses) is indistinguishable from an offline server by this
// return type alone. `status` is surfaced through the `onFailure` callback
// so a caller can report it rather than retrying into a wall forever.

import type { ToolCallBatch } from "./flush";

/** The subset of `fetch` this adapter uses. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * How long to wait for the ingest before giving up, in milliseconds.
 *
 * Longer than the hook's own ask timeout, because nothing is blocked on
 * this: a flush runs off the critical path, so waiting costs patience
 * rather than latency in a session. It is bounded at all because a flush
 * that hangs forever holds a process open and never retries.
 */
export const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;

export interface FlushHttpOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  /** Creates the abort signal for the timeout. Injected so the timeout is testable. */
  readonly timeoutSignal?: (ms: number) => AbortSignal | undefined;
  /**
   * Records what happened on a failed send, for the caller to report.
   *
   * A callback rather than a return value because `SendBatch` is a boolean
   * by design — the flush loop must not have to interpret a status to
   * decide whether to keep a record. This is how the *reason* escapes
   * without widening that contract.
   */
  readonly onFailure?: (failure: FlushFailure) => void;
}

/** Why one send did not succeed. */
export interface FlushFailure {
  /** The HTTP status, when there was a response at all. */
  readonly status?: number;
  /**
   * True when the server refused the *shape* rather than being unavailable.
   *
   * Worth separating because the two need opposite responses: an
   * unavailable server is waited out, and a refused shape will be refused
   * identically forever — a client bug that would otherwise present as a
   * spool that quietly fills up and starts dropping its oldest records.
   */
  readonly permanent: boolean;
}

/**
 * `4xx` other than the two that are genuinely transient.
 *
 * `408` and `429` are `4xx` by number and transient by meaning — a timeout
 * and a rate limit both succeed on a later attempt with the identical body,
 * so treating them as permanent would abandon records the server never
 * actually refused.
 */
function isPermanent(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Builds the `send` function `flushSpool` takes.
 *
 * The batch is posted exactly as the ingest's schema expects — `sessionId`
 * on the envelope, `calls` beneath it — because that schema is strict:
 * an unrecognised key is a rejected request, not an ignored field.
 * `toWireCall` in `./flush.ts` is what guarantees the calls themselves
 * carry nothing extra.
 */
export function createHttpFlush(
  options: FlushHttpOptions,
): (batch: ToolCallBatch) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const makeSignal =
    options.timeoutSignal ??
    ((ms: number) =>
      typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

  return async (batch) => {
    const signal = makeSignal(timeoutMs);
    try {
      const response = await options.fetch(
        `${options.baseUrl.replace(/\/+$/, "")}/api/tool-calls`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
          ...(signal === undefined ? {} : { signal }),
        },
      );

      if (response.ok) return true;
      options.onFailure?.({ status: response.status, permanent: isPermanent(response.status) });
      return false;
    } catch {
      // No response at all — unreachable, aborted, DNS. Never permanent:
      // there is no evidence the server would refuse this body, and
      // treating it as permanent would discard records over a flaky
      // network.
      options.onFailure?.({ permanent: false });
      return false;
    }
  };
}
