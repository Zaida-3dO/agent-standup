// The HTTP adapter's `checkpoint` endpoint (SCHEMA.md §18, §19 — agent-
// facing, one per MCP tool). Thin shell over `service.call`.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../_shared/respond";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const event = await service.call("checkpoint", body, { caller: { transport: "http" } });
    return NextResponse.json({ event: serializeAppendedEvent(event) }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
