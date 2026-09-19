// The HTTP adapter's `GET /sessions/{id}/shape` endpoint over
// `get_session_shape` (SCHEMA.md §19). A thin shell over one `service.call`.
//
// Under the session's own id rather than a bare `/shapes` collection: a shape
// is a reading OF one session and has no meaning apart from it, so the
// session belongs in the path where it cannot be omitted. The sibling
// `../register` and `../` routes are the write and the detail read of the
// same id.
//
// It exists because `get_session_shape` had no route at all — it was
// reachable on MCP and nowhere else — and a command bound to it would
// otherwise work on `--direct` and fail over the API, which is the binding
// divergence `tests/cli-http-binding.test.ts` exists to prevent.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../../_shared/respond";
import { queryInput } from "../../../_shared/query";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await context.params;
  // Read off the operation's own schema (`../../../_shared/query.ts`) for
  // every field except `sessionId`, which is the path param under a
  // different name and so is set directly rather than read from the query
  // string.
  const input: Record<string, unknown> = {
    sessionId: id,
    ...queryInput(request, "get_session_shape", ["sessionId"]),
  };

  try {
    const result = await service.call("get_session_shape", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
