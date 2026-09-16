// The HTTP adapter's `POST /items/{id}/blocked-on-tool` endpoint over
// `report_blocked_on_tool` (SCHEMA.md §19). A thin shell over one
// `service.call`.
//
// Item-scoped, following `items/{id}/artifacts` and `items/{id}/notes`: a
// report of a tool that could not be used is a report about the work an item
// asked for, so the item belongs in the path where it cannot be omitted.
//
// It exists because `report_blocked_on_tool` had no route at all — it was
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
    const input = { ...body, itemId: id };
    const result = await service.call("report_blocked_on_tool", input, { caller });
    return withRequestId(NextResponse.json(result, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
