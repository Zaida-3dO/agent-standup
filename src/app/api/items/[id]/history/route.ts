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
import { queryInput } from "../../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  // Read off the operation's own schema (`../../../_shared/query.ts`) for
  // every field except `id` (the path param, set directly).
  const input: Record<string, unknown> = {
    id,
    ...queryInput(request, "get_item_history", ["id"]),
  };

  try {
    const history = await service.call("get_item_history", input, { caller });
    return withRequestId(NextResponse.json(history), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
