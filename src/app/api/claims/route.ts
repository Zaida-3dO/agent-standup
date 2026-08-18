// The HTTP adapter's `claim` endpoint (SCHEMA.md §19 — agent-facing, one per
// MCP tool). Thin shell over `service.call`: parse the body, call the
// service, render the result. This route opens no transaction, resolves no
// settings, and imports no database client.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";

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
    const assignment = await service.call("claim", body, { caller });
    return withRequestId(NextResponse.json({ assignment }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
