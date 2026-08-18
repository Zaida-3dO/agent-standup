// The HTTP adapter's `POST /items/{id}/review-requests` endpoint (SCHEMA.md
// §3, §16). Records that a review was asked for — the `review_requested`
// event `artifact.review_requested` gates `in_review` on. Thin shell over
// `service.call`.
//
// A separate endpoint from `items/{id}/artifacts` because it writes a
// different kind of thing for a different reason: a request has no
// deliverable to attach, and is made by whoever *wants* the review rather
// than whoever performed it. See `record-artifact.ts`'s note on
// `requestReview` for the full reasoning.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const event = await service.call("request_review", { ...body, itemId: id }, { caller });
    return withRequestId(
      NextResponse.json({ event: serializeAppendedEvent(event) }, { status: 201 }),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
