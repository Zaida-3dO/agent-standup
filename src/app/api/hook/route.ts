// The HTTP adapter's `hook` endpoint (SCHEMA.md §19 `POST /hook`, machine-
// facing: "The dumb pipe. Sends event type, session, tool, command. Returns
// allow/deny for guarded patterns, or nudge text, or nothing."). Thin shell
// over `service.call` — same shape as every other route in this directory.
//
// MILESTONES.md #41: "The route is one caller; `standup hook` is another" —
// this file is that one caller. It has no logic of its own beyond parsing
// the request and shaping the response; the allow/ask/deny decision lives
// entirely in `hookDecision` (`src/lib/service/operations/hook-decision.ts`).
import { NextResponse } from "next/server";
import { service, interventionDeliverer } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";
import { ridesDigest } from "@/lib/interventions/digest";
import type { InterventionFinding } from "@/lib/interventions/types";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("hook_decision", body, { caller });
    // A `digest`-timed finding is held rather than returned (MILESTONES.md
    // #128). This is where findings enter the digest: `hook_decision` is
    // pure and holds no state, so the operation cannot do it - and this
    // route is already "the one caller" that owns the hook's side effects.
    //
    // The immediate findings still travel on the response exactly as they
    // did; `holdDeferred` takes only the ones whose timing says to wait,
    // and a blocking finding is never among them because `ridesDigest`
    // refuses to defer one. What is held is delivered on the next ordinary
    // service call this session makes, which is the natural juncture the
    // design asks for.
    holdDeferred(result, sessionIdOf(body));
    // A session that says it is stopping will not read another digest, so
    // whatever is held for it is dropped now rather than waiting out the
    // accumulator's TTL. This is the tidy path, not the guarantee: a
    // session that is killed, crashes, or whose `Stop` never arrives sends
    // nothing here, which is why `DigestAccumulator` sweeps by age as well
    // and does not depend on this call happening.
    forgetOnStop(body);
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/**
 * Drops a stopping session's held findings.
 *
 * Reads the body defensively for the same reason `holdDeferred` does: this
 * runs after a response has already been computed, and nothing about an
 * advisory batch may turn a decided hook answer into a failure.
 */
function forgetOnStop(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  if ((body as { eventType?: unknown }).eventType !== "Stop") return;
  const sessionId = sessionIdOf(body);
  if (sessionId === undefined) return;
  interventionDeliverer.forget(sessionId);
}

/** The session a hook event names, when it names one this route can use as a key. */
function sessionIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Holds this decision's `digest`-timed findings for the session's next
 * ordinary service call.
 *
 * Defensive about the shape on purpose. It reads a result typed as
 * `unknown` at this boundary, and a malformed one must not fail a hook
 * response that has already been computed - the hook fails open by design
 * (DECISIONS.md sec.16) and an advisory batch is the last thing that should
 * ever change that.
 */
function holdDeferred(result: unknown, sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  if (typeof result !== "object" || result === null) return;

  const findings = (result as { findings?: unknown }).findings;
  if (!Array.isArray(findings) || findings.length === 0) return;

  const deferred = findings.filter(
    (finding): finding is InterventionFinding =>
      typeof finding === "object" &&
      finding !== null &&
      ridesDigest(finding as InterventionFinding),
  );
  if (deferred.length === 0) return;

  interventionDeliverer.hold(sessionId, deferred, Date.now());
}
