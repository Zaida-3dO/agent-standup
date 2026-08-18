// The HTTP adapter's `POST /events/{id}/seen` endpoint — SCHEMA.md §19:
// "Mark read." §8b `event_seen`. MILESTONES.md #38.
//
// Thin shell over one `service.call("mark_event_seen", …)`, same shape as
// `POST /items/{id}/notes`: the event id comes from the path, everything
// else from the body, and the operation's schema is the one place either is
// validated.
//
// **200, not 201, and deliberately the same status on a repeat.** The
// operation is idempotent (`ON CONFLICT DO NOTHING`), so a second call is a
// success with nothing written. Answering 201-then-200 would leak that
// distinction into the status line and invite a caller to branch on it;
// `alreadySeen` in the body says which happened, for callers that care,
// without making the two calls look like different outcomes to callers that
// do not. 200 rather than 204 because there is a body worth reading — the
// original `seenAt`.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;

  // An empty body is legitimate here — every field this endpoint needs
  // beyond the path id is a single `personId`, and a caller sending none
  // should be refused by the schema naming that field, not by a JSON
  // parse error about a body they deliberately left empty.
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    const parsed = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("mark_event_seen", { ...body, eventId: id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
