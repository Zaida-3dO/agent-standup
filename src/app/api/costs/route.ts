// The HTTP adapter's `GET /costs` endpoint over `get_costs` (MILESTONES.md
// #53). Thin shell over `service.call`, same shape as every other route in
// this adapter — no transaction, no settings, no database client import
// here.
//
// This route did not exist before this task. It is added because the
// overnight report on the Standup home (`/`) needs a spend figure and the
// task's own brief is explicit: consume the operation's existing shape
// rather than inventing a parallel computation. `get_costs` was already
// registered and tested; only the adapter wiring to reach it over HTTP was
// missing, in the same gap `/cost` (the standalone cost screen) is still
// sitting behind a placeholder for.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  const groupBy = url.searchParams.get("groupBy");
  if (groupBy !== null) input.groupBy = groupBy;
  const since = url.searchParams.get("since");
  if (since !== null) input.since = since;
  const until = url.searchParams.get("until");
  if (until !== null) input.until = until;
  const itemId = url.searchParams.get("itemId");
  if (itemId !== null) input.itemId = itemId;
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = Number(limit);

  try {
    const result = await service.call("get_costs", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
