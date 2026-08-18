// The HTTP adapter's `backfill` endpoint (docs/plans/BACKFILL.md). Thin
// shell over `service.call` — every refusal, including "the window is
// closed", is produced by the service and rendered unedited.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse, httpCaller } from "../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const result = await service.call("backfill", body, { caller });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
