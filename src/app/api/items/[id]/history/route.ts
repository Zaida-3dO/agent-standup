// The HTTP adapter's paged item-history endpoint (T24). Thin shell over one
// `service.call`, exactly like `items/[id]/detail/route.ts` beside it
// (SCHEMA.md §22: "every way in … is a thin shell over one service call"):
// resolve the request into a name and an input, call the service, shape the
// result for the transport. No transaction opened, no settings resolved, no
// database client imported.
//
// Separate from `detail` rather than more parameters on it — see
// `get_item_history`'s own header for the consistency reasoning behind that
// split, which is the substance of the decision and not a routing detail.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../respond";
import { parseBooleanParam } from "../../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { id };

  // Each parameter is passed through when present and omitted entirely when
  // absent, so the operation's own defaults apply rather than this adapter
  // re-declaring them. A non-numeric `limit` is passed through as-is for the
  // schema to reject — an adapter that silently swallowed it would turn a
  // caller's mistake into a surprising default instead of an error naming
  // the field.
  const full = url.searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = Number.isNaN(parsed) ? limit : parsed;
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  try {
    const history = await service.call("get_item_history", input, { caller });
    return withRequestId(NextResponse.json(history), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
