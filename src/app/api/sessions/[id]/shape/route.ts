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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await context.params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { sessionId: id };

  // Forwarded untouched when it is not a number, so the schema refuses it
  // and names the field rather than this adapter substituting a default the
  // caller never asked for.
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = Number.isNaN(Number(limit)) ? limit : Number(limit);

  try {
    const result = await service.call("get_session_shape", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
