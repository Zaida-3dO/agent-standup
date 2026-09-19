// The HTTP adapter's `/items/{id}/loops` collection endpoints (SCHEMA.md
// §3a, §19). `POST` records a loose end on the item named in the path;
// `GET` lists the item's loops without reading its whole context. Thin
// shells over `service.call`.
//
// Item-scoped, following `items/{id}/notes`: a loop has no meaning apart from
// the item it was noticed on, so the item belongs in the path where it cannot
// be omitted.
//
// The list is a `GET` on the collection the write already posts to, rather
// than a new path: it is the same resource, read instead of appended to, and
// a second URL for the same collection is the kind of near-miss that has
// cost this API real calls before (see `scripts/generate-http-routes.mjs`).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../_shared/respond";
import { queryInput } from "../../../_shared/query";

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
    const added = await service.call("loop_add", { ...body, itemId: id }, { caller });
    // `loopId` is returned alongside the event because it is generated
    // server-side unless the caller supplied one, and without it the loop
    // that was just opened could never be closed.
    return withRequestId(
      NextResponse.json(
        { loopId: added.loopId, kind: added.kind, event: serializeAppendedEvent(added.event) },
        { status: 201 },
      ),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/**
 * `GET /items/{id}/loops` — the list read.
 *
 * Open loops that track work only by default; `?includeClosed=true` adds
 * resolved ones, `?includeDeleted=true` adds retracted ones, and
 * `?includeNonWork=true` adds notes. Read off the operation's own schema
 * (`../../../_shared/query.ts`) for every field except `itemId`, which is the
 * path param under a different name and so is set directly rather than read
 * from the query string. The three booleans now go through
 * `parseBooleanParam` like every other boolean on this surface — `?includeClosed`
 * bare and `1` now also mean true, where before only the literal string
 * `"true"` did; `"true"` itself still works, so no existing caller changes
 * meaning.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const input: Record<string, unknown> = {
    itemId: id,
    ...queryInput(request, "loop_list", ["itemId"]),
  };

  try {
    const result = await service.call("loop_list", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
