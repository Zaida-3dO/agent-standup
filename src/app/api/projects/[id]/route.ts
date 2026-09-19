// `GET /api/projects/{id}` — one project rolled up, for the project page
// (MILESTONES.md #75).
//
// On the projects collection rather than under `/api/items/{id}` because
// the answer is only defined for a project: `get_project_detail` refuses a
// task, which has a state of its own rather than one derived from
// children. A reader of an access log can see which was asked for.
//
// A thin shell over `service.call` (SCHEMA.md §22): parse the request into
// an input, call the service, render the result. No transaction, no
// settings resolution, no database client.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../items/respond";
import { queryInput } from "../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  // Read off the operation's own schema (`../../_shared/query.ts`) for
  // every field except `id` (the path param, set directly).
  const input: Record<string, unknown> = {
    id,
    ...queryInput(request, "get_project_detail", ["id"]),
  };

  try {
    const detail = await service.call("get_project_detail", input, { caller });
    return withRequestId(NextResponse.json({ detail }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
