// The HTTP adapter's `kill-guard` endpoint (MILESTONES.md #45). Thin shell
// over `service.call` — same shape as every other route in this directory,
// and it holds none of the judgement: the ownership check is `kill_guard`
// in the service layer, and the registry it reads is reachable from nowhere
// else.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  httpCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("kill_guard", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
