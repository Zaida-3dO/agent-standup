// The HTTP adapter's `POST /items/{id}/notes` endpoint (SCHEMA.md §19,
// human-facing: "Leave a timestamped remark (an `events` row of type
// `note`)"). Thin shell over `service.call`.
//
// Uses the shared `_shared/respond.ts` (not the sibling `items/respond.ts`
// row #26 owns) for the same reason `claims/` and `checkpoints/` do — see
// `_shared/respond.ts`'s header.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const event = await service.call("note", { ...body, itemId: id }, { caller });
    return withRequestId(
      NextResponse.json({ event: serializeAppendedEvent(event) }, { status: 201 }),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
