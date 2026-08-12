// The HTTP adapter's `claim` endpoint (SCHEMA.md §19 — agent-facing, one per
// MCP tool). Thin shell over `service.call`: parse the body, call the
// service, render the result. This route opens no transaction, resolves no
// settings, and imports no database client.
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
    const assignment = await service.call("claim", body, { caller: { transport: "http" } });
    return NextResponse.json({ assignment }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
