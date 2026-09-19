// The HTTP adapter's `progress_report` endpoint (MILESTONES.md #136). Thin
// shell over `service.call`, same shape as every other route in this adapter
// — no transaction, no settings, no database client import here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`).
  // `includeCompleted` now goes through `parseBooleanParam` like every other
  // boolean on this surface — `?includeCompleted` bare and `1` now also
  // mean true, where before only the literal string `"true"` did. `"true"`
  // itself still works, so no existing caller changes meaning.
  const input = queryInput(request, "progress_report");

  try {
    const result = await service.call("progress_report", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
