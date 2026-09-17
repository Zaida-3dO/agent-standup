// The HTTP adapter's `GET /interventions/scores` endpoint over
// `get_intervention_scores` (SCHEMA.md §19). A thin shell over one
// `service.call`.
//
// A sibling of the `/interventions` collection rather than a path under an
// event id, because it aggregates ACROSS firings per catalogue entry —
// `?entryId=` narrows it to one, which is a filter on the aggregate rather
// than a different resource.
//
// It exists because `get_intervention_scores` had no route at all — it was
// reachable on MCP and nowhere else — and a command bound to it would
// otherwise work on `--direct` and fail over the API.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../_shared/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);

  const input: Record<string, unknown> = {};
  for (const name of ["since", "entryId"] as const) {
    const raw = url.searchParams.get(name);
    if (raw !== null) input[name] = raw;
  }
  const threshold = url.searchParams.get("threshold");
  if (threshold !== null) {
    input.threshold = Number.isNaN(Number(threshold)) ? threshold : Number(threshold);
  }

  try {
    const result = await service.call("get_intervention_scores", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
