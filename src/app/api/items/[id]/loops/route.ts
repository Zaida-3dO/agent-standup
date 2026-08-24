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
 * `?includeNonWork=true` adds notes. Query parameters arrive as
 * strings, so each is compared against `"true"` here rather than passed
 * through — an absent parameter has to mean `false`, and the string `"false"`
 * must not read as truthy, which is exactly what forwarding the raw value
 * into a boolean field would do.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { itemId: id };
  if (url.searchParams.get("includeClosed") === "true") input.includeClosed = true;
  if (url.searchParams.get("includeDeleted") === "true") input.includeDeleted = true;
  if (url.searchParams.get("includeNonWork") === "true") input.includeNonWork = true;
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = limit;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  try {
    const result = await service.call("loop_list", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
