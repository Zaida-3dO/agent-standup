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
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  httpCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("hook_decision", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
