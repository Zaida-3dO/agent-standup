// The HTTP adapter's document endpoints — `GET` and `PATCH` on
// `/items/{id}/docs/{doc}` (SCHEMA.md §8c, §19). Thin shells over one
// `service.call` each, exactly like `items/[id]/loops/[loopId]/route.ts`
// beside it: resolve the request into an operation input, call the service,
// shape the result for the transport. No transaction opened, no settings
// resolved, no database client imported.
//
// `GET` reads entries (`doc_get`): `?keys=a&keys=b` names them, `?prefix=`
// selects a range, `?cursor=` and `?limit=` page. `PATCH` writes some keys
// (`doc_patch`) from a body of `{set?, delete?, ifRev?}` — a PATCH because
// it changes the named keys and leaves the rest of the document alone. A
// revision clash answers 409 with the current revision, like any conflict.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serviceErrorResponse,
} from "../../../../_shared/respond";
import { queryInput } from "../../../../_shared/query";

type DocParams = { params: Promise<{ id: string; doc: string }> };

/** `GET /items/{id}/docs/{doc}` — entries of one document, paged. */
export async function GET(request: Request, { params }: DocParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, doc } = await params;

  // Every field but the two path parameters is read off the operation's own
  // schema (`_shared/query.ts`), so a field the operation gains is not one
  // this route has to be taught.
  const input: Record<string, unknown> = {
    itemId: id,
    doc,
    ...queryInput(request, "doc_get", ["itemId", "doc"]),
  };

  try {
    const result = await service.call("doc_get", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/** `PATCH /items/{id}/docs/{doc}` — write and delete some keys. */
export async function PATCH(request: Request, { params }: DocParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, doc } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("doc_patch", { ...body, itemId: id, doc }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
