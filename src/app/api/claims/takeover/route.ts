// The HTTP adapter's `takeover` endpoint (SCHEMA.md §19, MILESTONES.md #99).
// Thin shell over `service.call` — see ../../route.ts.
//
// Under `/api/claims/` alongside claim, release and heartbeat because that is
// what it operates on: an assignment row. It is not a new resource, it is the
// fourth thing that can happen to a claim.
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
    const result = await service.call("takeover", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
