// The HTTP adapter's `release` endpoint (SCHEMA.md §19). Thin shell over
// `service.call` — see ../route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse, httpCaller } from "../../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const assignment = await service.call("release", body, { caller });
    return NextResponse.json({ assignment });
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
