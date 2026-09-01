// The HTTP adapter's `sweep` endpoint (SCHEMA.md §19, MILESTONES.md #99).
// Thin shell over `service.call` — see ../claims/route.ts.
//
// **`POST`, not `GET`, and a body is not required.** The sweep writes:
// it moves assignments along the liveness ladder, releases claims and can
// escalate an item to `blocked`. A `GET` that mutates is the kind of endpoint
// a crawler, a prefetch or a browser's own retry will invoke without anyone
// asking it to, and the thing being invoked here releases other sessions'
// claims. The operation's schema has one optional field, `dryRun`, so a
// caller sends `{}`, `{"dryRun": true}`, or nothing at all — an absent body
// is read as `{}` rather than refused, since a live sweep is the default and
// rejecting an empty body would be pedantry with no reader to serve.
//
// `dryRun` is deliberately opt-in rather than the default. Flipping it would
// silently turn every existing scheduled invocation into a no-op that still
// answers 200, which is the silent-success shape this codebase treats as
// worse than an outage — an operator's cron would go on reporting healthy
// while claims leaked.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    // A body that is present but not JSON is still an input error — it is
    // the caller sending something, badly, rather than sending nothing.
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("sweep", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
