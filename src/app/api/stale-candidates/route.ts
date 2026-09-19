// The HTTP adapter's stale-candidates endpoint. Thin shell over one
// `service.call` (SCHEMA.md §22), like every other read route: no
// transaction, no settings, no database client.
//
// See `get_stale_candidates`'s header for why this is a read of its own
// rather than a flag on the board: a citation is a scan across other rows'
// artifacts, not a predicate on one row's columns, so it does not belong on
// the hottest read in the product.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId } from "../_shared/respond";
import { serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`).
  const input = queryInput(request, "get_stale_candidates");

  try {
    const result = await service.call("get_stale_candidates", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
