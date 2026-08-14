// The HTTP adapter's `POST /items/{id}/artifacts` endpoint (SCHEMA.md §6,
// §19). Records an artifact against the item named in the path. Thin shell
// over `service.call`.
//
// Item-scoped rather than a bare `/artifacts` collection, following
// `items/{id}/notes` — an artifact has no meaning apart from the item it was
// produced for, so the item belongs in the path where it cannot be omitted.
//
// Uses the shared `_shared/respond.ts` (not the sibling `items/respond.ts`)
// for the same reason `claims/`, `checkpoints/` and `items/{id}/notes` do —
// see `_shared/respond.ts`'s header.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse } from "../../../_shared/respond";

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
    const artifact = await service.call(
      "record_artifact",
      { ...body, itemId: id },
      { caller: { transport: "http" } },
    );
    // `createdAt` is a `Date`; everything else the operation returns is a
    // string, a number or null. There is no bigint in this shape — unlike an
    // appended event, whose `id`/`txId` need `serializeAppendedEvent` — so
    // the row serialises as-is apart from the timestamp.
    return NextResponse.json(
      { artifact: { ...artifact, createdAt: artifact.createdAt.toISOString() } },
      { status: 201 },
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
