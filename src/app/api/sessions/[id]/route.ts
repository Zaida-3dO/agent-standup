// The HTTP adapter's `GET /sessions/{id}` endpoint over `get_session_detail`
// (T19) — one session end to end.
//
// A thin shell over one `service.call`, the same shape as every other read
// route in this adapter: no transaction, no settings, no database client.
// The sibling `[id]/register` route is the write side of the same id.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../items/respond";
import { queryInput } from "../../_shared/query";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await context.params;
  // Read off the operation's own schema (`../../_shared/query.ts`) for
  // every field except `sessionId`, which is the path param under a
  // different name and so is set directly rather than read from the query
  // string.
  const input: Record<string, unknown> = {
    sessionId: id,
    ...queryInput(request, "get_session_detail", ["sessionId"]),
  };

  try {
    const result = await service.call("get_session_detail", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
