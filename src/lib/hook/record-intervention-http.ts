// Sending intervention captures to `POST /api/interventions` — the client
// half of MILESTONES.md #128's capture loop
// (`src/lib/interventions/capture.ts`), the same way `flush-http.ts` is the
// client half of `POST /api/tool-calls`.
//
// This is an adapter and it obeys the adapter rule (CLAUDE.md, "Working in
// this repo"): it shapes one request, makes one call, and reduces the
// answer to a boolean. It reaches no database and holds no judgement about
// which findings are worth recording — that is `buildCaptures`'s job, and
// this module never sees a raw `InterventionFinding`, only what
// `buildCaptures` already turned it into.
//
// ── Every failure is the same value, deliberately ──────────────────────
//
// `false` for an unreachable server, a non-success status, and a body that
// could not be read. Same collapse `./ask-http.ts` and `./flush-http.ts`
// make, for the same reason: the one caller of this function
// (`../../bin/standup-hook.ts`) has exactly one response to any of them —
// the capture is lost, and that is the accepted failure mode.
// `record-intervention.ts`'s own header states it outright: "a hook that
// cannot reach this operation still gets its decision; it loses the
// evidence loop, not the guard" — the same fail-open posture `/hook`
// itself takes, applied to something even less critical than the decision.
//
// ── Deliberately not spooled ────────────────────────────────────────────
//
// `SpooledToolCall` (`./spool-record.ts`) carries no `findings`, no
// `level`, no `entryId` — it is shaped for tool-call telemetry, and
// widening it to also carry captures would be a second contract change
// riding in on this one. Findings are rare (`capture.ts`'s own header:
// "more than a couple triggering on one call is already unusual"), the
// write is already optional, and it has a full round trip's worth of
// findings in hand at the moment `runHook`'s `onFindings` fires — so a
// direct, best-effort send costs nothing on the overwhelming majority of
// calls, which trigger no finding and never reach this file at all.

import type { InterventionCapture } from "../interventions/capture";

/** The subset of `fetch` this adapter uses. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * How long to wait for the ingest before giving up, in milliseconds.
 *
 * Shorter than `flush-http.ts`'s ceiling for the same reason as before:
 * unlike a flush, this runs on the critical path of the process exiting —
 * `runHook` awaits it before `standup-hook.ts` writes its response and
 * returns.
 *
 * **Deliberately shorter than `ask-http.ts`'s own ceiling, though, not
 * equal to it** (row a5af3691 on the capture-loop follow-up, filed against
 * an earlier version of this file that copied `ask-http.ts`'s 5000ms
 * outright). Fire-and-forget was considered and rejected: `standup-hook.ts`
 * exits right after `main()` returns with nothing else keeping the event
 * loop alive, and `tests/hook-run.test.ts`'s "is awaited before runHook
 * resolves" pins exactly this — an un-awaited send would routinely be
 * killed mid-flight by the process exiting, trading a bounded delay for an
 * *unbounded* loss rate. But a lost capture still costs strictly less than
 * a delayed tool call, so the capture should not borrow the decision's full
 * patience either: `POST /api/interventions` does one small insert, not the
 * decision logic `ask-http.ts` waits on, so it does not need the same
 * ceiling to complete on any request that is actually going to succeed. A
 * hung server now costs at most this long added to a real tool call, on top
 * of `ask-http.ts`'s own ceiling — not this plus an equal second helping of
 * it.
 */
export const DEFAULT_RECORD_TIMEOUT_MS = 1500;

export interface RecordInterventionHttpOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /**
   * The bearer token the endpoint requires, when the deployment requires
   * one. Same posture as `flush-http.ts`'s `token`: `POST /interventions`
   * authenticates unconditionally, so a send with no token is a permanent
   * `401` — silent, because the caller of this function never surfaces a
   * status, only a boolean.
   */
  readonly token?: string;
  readonly timeoutMs?: number;
  /** Creates the abort signal for the timeout. Injected so the timeout is testable. */
  readonly timeoutSignal?: (ms: number) => AbortSignal | undefined;
}

/** What one call posts: one session's captures from one decision. */
export interface InterventionCaptureBatch {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly captures: readonly InterventionCapture[];
}

/**
 * Reduces one batch to what `record_intervention` accepts on the wire.
 *
 * `InterventionCapture` already carries `sessionId` and `rootSessionId` on
 * every entry (`capture.ts` — each capture is self-describing, because the
 * spool it might otherwise have ridden interleaves sessions). The
 * operation's input hoists them onto the envelope instead, once per
 * request rather than once per capture, so this is where the two shapes
 * are reconciled — the same job `toWireCall` does in `./flush.ts`, for the
 * same reason: the compiler asks what the wire body should do with a field
 * added to `InterventionCapture` later, at the one place that has to
 * decide, rather than a request silently gaining or losing it.
 */
export function toWireBatch(batch: InterventionCaptureBatch): Record<string, unknown> {
  return {
    sessionId: batch.sessionId,
    ...(batch.rootSessionId === undefined ? {} : { rootSessionId: batch.rootSessionId }),
    captures: batch.captures.map((capture) => ({
      entryId: capture.entryId,
      outcome: capture.outcome,
      level: capture.level,
      phase: capture.phase,
      ...(capture.itemId === undefined ? {} : { itemId: capture.itemId }),
      ...(capture.tool === undefined ? {} : { tool: capture.tool }),
      ...(capture.command === undefined ? {} : { command: capture.command }),
      ...(capture.message === undefined ? {} : { message: capture.message }),
    })),
  };
}

/**
 * Builds the sender `standup-hook.ts` calls from `runHook`'s `onFindings`.
 *
 * Never throws — every failure is swallowed to `false`, for the reason
 * `flush-http.ts` gives for the same shape: a caller that had to enumerate
 * failure modes could forget one and treat it as success, and here that
 * would only ever cost a log line no one reads, since nothing retries a
 * failed capture the way a flush retries a failed batch.
 */
export function createRecordInterventionHttp(
  options: RecordInterventionHttpOptions,
): (batch: InterventionCaptureBatch) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECORD_TIMEOUT_MS;
  const makeSignal =
    options.timeoutSignal ??
    ((ms: number) =>
      typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

  return async (batch) => {
    if (batch.captures.length === 0) return true;

    const signal = makeSignal(timeoutMs);
    try {
      const response = await options.fetch(
        `${options.baseUrl.replace(/\/+$/, "")}/api/interventions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token === undefined || options.token === ""
              ? {}
              : { authorization: `Bearer ${options.token}` }),
          },
          body: JSON.stringify(toWireBatch(batch)),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  };
}
