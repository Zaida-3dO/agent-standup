// The HTTP adapter's `POST /items/{id}/loops/{loopId}/close` endpoint
// (SCHEMA.md §3a, §19). Closes an open loop. Thin shell over `service.call`.
//
// A sub-path of the loop rather than a `DELETE` on it, because closing a loop
// is not deleting it: both events stay in the ledger forever, and the loop's
// history is the point. `DELETE` would describe the opposite of what happens.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../../../_shared/respond";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; loopId: string }> },
) {
  const { requestId, caller } = httpCaller(request);
  const { id, loopId } = await params;
  let body: Record<string, unknown>;
  try {
    // The parse is allowed to throw, exactly as the sibling routes let it —
    // `.catch(() => ({}))` here would make the surrounding handler
    // unreachable and accept a malformed body as an empty one. Everything
    // this endpoint needs is in the path, so swallowing would even be
    // defensible; it is not worth one endpoint disagreeing with every other
    // about what a broken request means.
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const event = await service.call("loop_close", { ...body, itemId: id, loopId }, { caller });
    return withRequestId(
      NextResponse.json({ event: serializeAppendedEvent(event) }, { status: 201 }),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
