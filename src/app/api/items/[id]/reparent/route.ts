// `POST /api/items/{id}/reparent` — `reparent_item`, the other half of the
// tree repair (MILESTONES.md #75). See `../retype/route.ts` for why both of
// these get a named path rather than a field on `PATCH /api/items/{id}`.
//
// **`parentId` is nullable, not optional**, and the difference is load
// bearing: `null` means "make this a top-level project", while omitting it
// is invalid input. So the body is passed through as given rather than
// having absent keys stripped — a route that treated a missing `parentId`
// as `null` would silently promote an item to the root on a malformed
// request.
//
// A thin shell over `service.call` (SCHEMA.md §22).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
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
    const item = await service.call("reparent_item", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
