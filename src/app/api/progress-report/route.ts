// The HTTP adapter's `progress_report` endpoint (MILESTONES.md #136). Thin
// shell over `service.call`, same shape as every other route in this adapter
// — no transaction, no settings, no database client import here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, withRequestId, serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const { requestId, caller } = httpCaller(request);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const includeCompleted = url.searchParams.get("includeCompleted");

  const input: Record<string, unknown> = {};
  if (sessionId !== null) input.sessionId = sessionId;
  // Only forwarded when present, so an absent parameter reaches the schema's
  // own default rather than being decided here — a route that resolved it
  // would be a second place the default lives. `"true"` is the only spelling
  // accepted as true, so a typo reads as false rather than as an unbounded
  // report nobody asked for.
  if (includeCompleted !== null) input.includeCompleted = includeCompleted === "true";

  try {
    const result = await service.call("progress_report", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
