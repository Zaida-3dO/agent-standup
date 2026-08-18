// The HTTP adapter's `get_crew_name` endpoint (SCHEMA.md §18, §19 —
// agent-facing, one per MCP tool). Thin shell over `service.call`: parse the
// body, call the service, render the result. This route opens no
// transaction, resolves no settings, and imports no database client — same
// shape as `src/app/api/claims/route.ts`.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  httpCaller,
  withRequestId,
} from "../../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const name = await service.call("get_crew_name", body, { caller });
    return withRequestId(NextResponse.json({ name }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
