// The HTTP adapter's `GET /runs/scores` endpoint over `get_run_scores`
// (SCHEMA.md §19). A thin shell over one `service.call`.
//
// A sibling of the `/runs` collection rather than a path under a run id,
// because it aggregates ACROSS runs — `?runId=` narrows it to one, which is a
// filter on the aggregate rather than a different resource.
//
// It exists because `get_run_scores` had no route at all — it was reachable
// on MCP and nowhere else — and a command bound to it would otherwise work on
// `--direct` and fail over the API.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../_shared/respond";
import { queryInput } from "../../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../../_shared/query.ts`).
  const input = queryInput(request, "get_run_scores");

  try {
    const result = await service.call("get_run_scores", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
