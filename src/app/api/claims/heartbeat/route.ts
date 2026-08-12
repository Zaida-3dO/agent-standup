// The HTTP adapter's `heartbeat` endpoint (SCHEMA.md §19). Thin shell over
// `service.call` — see ../route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse } from "../../_shared/respond";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const assignment = await service.call("heartbeat", body, { caller: { transport: "http" } });
    return NextResponse.json({ assignment });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
