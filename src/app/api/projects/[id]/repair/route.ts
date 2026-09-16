// The HTTP adapter's `POST /projects/{id}/repair` endpoint over
// `repair_stuck_projects` (SCHEMA.md §19). A thin shell over one
// `service.call`.
//
// `POST` rather than `GET` even though it writes nothing unless asked: the
// operation takes an `apply` flag and the applying form is the reason it
// exists, so the method is chosen for what the endpoint is for rather than
// for its most cautious call. The operation defaults `apply` to false, so a
// bare POST reports what it WOULD change and writes nothing.
//
// It exists because `repair_stuck_projects` had no route at all — it was
// reachable on MCP and nowhere else — and a command bound to it would
// otherwise work on `--direct` and fail over the API.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await context.params;
  // Parsed here rather than through a shared reader, matching the sibling
  // `items/{id}/artifacts` route: a body that is absent or not an object is
  // an empty input, so the operation's own schema is what names the missing
  // field rather than this route inventing a message for it.
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const input = { ...body, projectId: id };
    const result = await service.call("repair_stuck_projects", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
