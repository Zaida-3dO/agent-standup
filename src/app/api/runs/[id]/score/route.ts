// The HTTP adapter's `POST /runs/{id}/score` endpoint over `score_run`
// (SCHEMA.md §19). A thin shell over one `service.call`.
//
// Records a score for the run named in the path. The run belongs in the
// path where it cannot be omitted; everything else — who is rating, and the
// per-facet scores — is the body.
//
// It exists because `score_run` had no route at all — it was reachable on MCP
// and nowhere else — and a command bound to it would otherwise work on
// `--direct` and fail over the API.
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
    const result = await service.call("score_run", { ...body, runId: id }, { caller });
    return withRequestId(NextResponse.json(result, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
