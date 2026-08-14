// The HTTP adapter's `kill-guard` endpoint (MILESTONES.md #45). Thin shell
// over `service.call` — same shape as every other route in this directory,
// and it holds none of the judgement: the ownership check is `kill_guard`
// in the service layer, and the registry it reads is reachable from nowhere
// else.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse } from "../_shared/respond";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const result = await service.call("kill_guard", body, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
