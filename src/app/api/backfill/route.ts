// The HTTP adapter's `backfill` endpoint (docs/plans/BACKFILL.md). Thin
// shell over `service.call` — every refusal, including "the window is
// closed", is produced by the service and rendered unedited.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("backfill", body, { caller });
    return withRequestId(NextResponse.json(result, { status: 200 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
