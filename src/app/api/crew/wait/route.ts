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

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  // `since` is forwarded as the string it arrived as. It is a `bigint`
  // cursor, so the operation's schema takes a digit string and never a
  // number — parsing it here would be the precision loss that field exists
  // to avoid.
  const since = url.searchParams.get("since");
  if (since !== null) input.since = since;

  // `timeout` and `limit` are numbers in the schema, so they have to arrive
  // as numbers. A non-numeric string is forwarded untouched rather than
  // dropped or coerced, for the reason `events/route.ts` gives for the same
  // pattern: the schema then refuses it naming the parameter the caller
  // actually typed, which is a better answer than silently serving a
  // different wait than the one asked for.
  for (const name of ["timeout", "limit"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null) continue;
    const parsed = Number(raw);
    input[name] = raw.trim() !== "" && Number.isFinite(parsed) ? parsed : raw;
  }

  try {
    const result = await service.call("wait_for_crew", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
