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
import { parseBooleanParam } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  // Every parameter is passed through exactly as given, including a
  // malformed one — the operation's schema is what refuses it, so the same
  // `invalid_input` names the same field on every adapter, which is what
  // §22's first assertion compares.
  const repo = url.searchParams.get("repo");
  if (repo !== null) input.repo = repo;
  const area = url.searchParams.get("area");
  if (area !== null) input.area = area;
  const includeUnlanded = url.searchParams.get("includeUnlanded");
  if (includeUnlanded !== null) input.includeUnlanded = parseBooleanParam(includeUnlanded);
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = Number.isNaN(parsed) ? limit : parsed;
  }

  try {
    const result = await service.call("get_stale_candidates", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
