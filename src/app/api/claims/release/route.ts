// The HTTP adapter's `release` endpoint (SCHEMA.md §19). Thin shell over
// `service.call` — see ../route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../../_shared/respond";

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
    const assignment = await service.call("release", body, { caller });
    return withRequestId(NextResponse.json({ assignment }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
