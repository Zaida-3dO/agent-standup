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
import { log } from "@/lib/log";

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
    // The findings the accumulator would not hold. They still ride this
    // response — `hook_decision` returns them and nothing removes them —
    // so nothing is lost here; what is lost is their place in a later
    // batch. Saying so is how a session hitting the bound becomes visible
    // at all, rather than silently getting smaller digests than it earned.
    const sessionId = sessionIdOf(body);
    reportRefusedHolds(holdDeferred(result, sessionId), sessionId, requestId);
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

/**
 * Says when the digest would not hold what it was offered.
 *
 * The accumulator refuses only at its per-session bound, so this is a
 * session producing more than `maxPending` distinct digest-timed findings
 * inside one window. That is a real situation about that session — it is
 * the "same finding hundreds of times" case the bound exists for — and
 * before this it was invisible: `hold` discarded the answer and nothing
 * counted the drops.
 *
 * `warn` rather than `error`: the findings still ride this response, so
 * nothing is broken. What it flags is a session whose later digests will
 * be incomplete, which is worth seeing and is not a failure.
 *
 * The findings' ids travel, not their text. The ids are what identify a
 * runaway entry, and a log line is not a place to copy session-derived
 * message content into.
 */
function reportRefusedHolds(
  refused: readonly InterventionFinding[],
  sessionId: string | undefined,
  requestId: string,
): void {
  if (refused.length === 0) return;
  log.warn("digest declined to hold findings at the per-session bound", {
    requestId,
    sessionId,
    refusedCount: refused.length,
    findingIds: refused.map((finding) => finding.id),
  });
}

/** The session a hook event names, when it names one this route can use as a key. */
function sessionIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Holds this decision's `digest`-timed findings for the session's next
 * ordinary service call, and reports which of them could not be held.
 *
 * Defensive about the shape on purpose. It reads a result typed as
 * `unknown` at this boundary, and a malformed one must not fail a hook
 * response that has already been computed - the hook fails open by design
 * (DECISIONS.md sec.16) and an advisory batch is the last thing that should
 * ever change that.
 *
 * ── What the refusals mean on THIS path, precisely ────────────────────
 *
 * The accumulator refuses at its per-session bound. On the service path
 * `decideDelivery` promotes a refused finding to immediate, because there
 * the deferred findings were removed from the response and holding is the
 * only thing keeping them alive.
 *
 * **Here they are not lost, and the difference is worth stating rather
 * than assuming.** `hook_decision` returns every finding on `findings` in
 * registry order, and the filter below only *reads* that array — it never
 * removes anything. So a digest-timed finding rides this response whether
 * or not the accumulator held it, and a refusal costs the session nothing
 * on this call. What it costs is the *next* call: the finding will not
 * appear in a later batch, because nothing is holding it.
 *
 * The refusals are surfaced anyway, for two reasons. They are the honest
 * answer to "what did you take", so a caller reasoning about what a digest
 * will contain is not misled; and this route is the only production caller
 * today, so leaving `hold` silent would mean the next caller — one that
 * *does* drop deferred findings from its response, as the service path
 * does — inherits the same silent loss with nothing to warn it.
 */
function holdDeferred(
  result: unknown,
  sessionId: string | undefined,
): readonly InterventionFinding[] {
  if (sessionId === undefined) return [];
  if (typeof result !== "object" || result === null) return [];

  const findings = (result as { findings?: unknown }).findings;
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const deferred = findings.filter(
    (finding): finding is InterventionFinding =>
      typeof finding === "object" &&
      finding !== null &&
      ridesDigest(finding as InterventionFinding),
  );
  if (deferred.length === 0) return [];

  return interventionDeliverer.hold(sessionId, deferred, Date.now());
}
