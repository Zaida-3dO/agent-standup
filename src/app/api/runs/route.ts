// The HTTP adapter's `GET /runs` endpoint over `list_runs` (SCHEMA.md §19).
// A thin shell over one `service.call`.
//
// The collection the scoring endpoints hang off: `list_runs` is what returns
// the run id every other scoring operation asks for, so it is the one a
// caller reaches first.
//
// It exists because `list_runs` had no route at all — it was reachable on MCP
// and nowhere else — and a command bound to it would otherwise work on
// `--direct` and fail over the API.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../_shared/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);

  // Only parameters actually present are forwarded, so the schema's own
  // defaults decide every absent case rather than this adapter inventing one.
  const input: Record<string, unknown> = {};
  for (const name of ["itemId", "sessionId", "since", "scored"] as const) {
    const raw = url.searchParams.get(name);
    if (raw !== null) input[name] = raw;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = Number.isNaN(Number(limit)) ? limit : Number(limit);

  try {
    const result = await service.call("list_runs", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
