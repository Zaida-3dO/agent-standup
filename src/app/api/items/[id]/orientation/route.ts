// The HTTP adapter's orientation endpoint (SCHEMA.md §19
// `GET /items/{id}/orientation`, MILESTONES.md #28). Thin shell over
// `service.call`, exactly like `items/route.ts` and `items/[id]/route.ts`
// (SCHEMA.md §22: "every way in ... is a thin shell over one service
// call") — parse the request into a name and an input, call the service,
// render the result. No transaction opened, no settings resolved, no
// database client imported here.
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
  // every field except `itemId`, which is the path param under a different
  // name and so is set directly rather than read from the query string.
  // `limit` matters here in particular: orientation is one of the reads
  // most likely to overflow the response ceiling — 40 loops measured
  // 321,056 characters through it.
  const input: Record<string, unknown> = {
    itemId: id,
    ...queryInput(request, "orientation", ["itemId"]),
  };

  try {
    const result = await service.call("orientation", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
