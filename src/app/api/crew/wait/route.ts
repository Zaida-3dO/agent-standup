// The HTTP adapter's `GET /crew/wait?since=&timeout=` endpoint — SCHEMA.md
// §19: "**Long-poll.** Returns on the first crew event after `since` that is
// below the transaction-visibility horizon, or empty at the timeout."
// MILESTONES.md #64.
//
// A thin shell over one `service.call("wait_for_crew", …)`: it opens no
// transaction, resolves no settings, and imports no database client
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Same
// shape as `src/app/api/events/route.ts`, which this is modelled on.
//
// **This route holds a request open, and that is the one way it differs from
// every other read here.** The bound is not this route's to choose — the
// operation clamps `timeout` to `crew.wait_timeout_seconds`, which SCHEMA.md
// §17 sizes to stay inside the shortest prompt-cache lifetime a session may
// be given. A caller asking for longer gets the configured maximum rather
// than a refusal, so nothing a client sends can make this route hold a
// connection indefinitely.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../items/respond";
import { queryInput } from "../../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../../_shared/query.ts`). `since`
  // is a `z.string()` cursor (a `bigint` spelled as digits), so it is read
  // as the raw string — never a number — same as before; `timeout` and
  // `limit` are numbers and coerced the same way `events/route.ts` does.
  const input = queryInput(request, "wait_for_crew");

  try {
    const result = await service.call("wait_for_crew", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
