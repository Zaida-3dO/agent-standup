// The HTTP adapter's `POST /items/{id}/loops` endpoint (SCHEMA.md §3a, §19).
// Records a loose end on the item named in the path. Thin shell over
// `service.call`.
//
// Item-scoped, following `items/{id}/notes`: a loop has no meaning apart from
// the item it was noticed on, so the item belongs in the path where it cannot
// be omitted.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse();
  }

  try {
    const added = await service.call(
      "loop_add",
      { ...body, itemId: id },
      { caller: { transport: "http" } },
    );
    // `loopId` is returned alongside the event because it is generated
    // server-side unless the caller supplied one, and without it the loop
    // that was just opened could never be closed.
    return NextResponse.json(
      { loopId: added.loopId, event: serializeAppendedEvent(added.event) },
      { status: 201 },
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
