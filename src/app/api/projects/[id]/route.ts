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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { id };

  // Parsed to a number rather than passed through as text, because every
  // query param arrives as a string and the operation's schema types these
  // as integers — handing over the raw string would be refused as invalid
  // input rather than honoured. `Number` on a non-numeric value yields
  // `NaN`, which the schema then rejects with a message naming the field,
  // and that is the intended outcome: a bad limit should say so, not
  // silently fall back to the default.
  const activityLimit = url.searchParams.get("activityLimit");
  if (activityLimit !== null) input.activityLimit = Number(activityLimit);
  const childLimit = url.searchParams.get("childLimit");
  if (childLimit !== null) input.childLimit = Number(childLimit);

  try {
    const detail = await service.call("get_project_detail", input, { caller });
    return withRequestId(NextResponse.json({ detail }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
