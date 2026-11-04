// The HTTP adapter's `GET /items/{id}/docs/{doc}/children` endpoint
// (SCHEMA.md §8c, §19) — one document across an item's children
// (`doc_list`). Thin shell over `service.call`, as its sibling one level up.
// `?cursor=` and `?limit=` page; follow `nextCursor` until it is null.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  serviceErrorResponse,
} from "../../../../../_shared/respond";
import { queryInput } from "../../../../../_shared/query";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; doc: string }> },
) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, doc } = await params;

  const input: Record<string, unknown> = {
    parentId: id,
    doc,
    ...queryInput(request, "doc_list", ["parentId", "doc"]),
  };

  try {
    const result = await service.call("doc_list", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
