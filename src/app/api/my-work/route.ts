// The HTTP adapter's `my_work` endpoint (SCHEMA.md §18 `my_work`,
// MILESTONES.md #28). Thin shell over `service.call`, same shape as every
// other route in this adapter — no transaction, no settings, no database
// client import here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const input: Record<string, unknown> = {};
  if (sessionId !== null) input.sessionId = sessionId;

  try {
    const result = await service.call("my_work", input, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
