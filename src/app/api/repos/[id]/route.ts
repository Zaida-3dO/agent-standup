// The HTTP adapter's single-repo endpoint — SCHEMA.md §19 `GET /repos/{id}`,
// `PATCH /repos/{id}`. Thin shell over `service.call` — see ../route.ts.
// MILESTONES.md #92.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../../admin-respond";
import { readDeleteInput } from "../../_shared/reference-row";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  try {
    const repo = await service.call("get_repo", { id }, { caller });
    return withRequestId(NextResponse.json({ repo }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse(requestId);

  try {
    const repo = await service.call("update_repo", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ repo }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

// `DELETE /repos/{id}` — the hard delete half of MILESTONES.md #96.
//
// Separate from the `PATCH` above because deleting and archiving are two
// different operations, not one operation with a flag: `PATCH` with
// `archived: true` keeps the row and every reference to it, and is what a
// caller almost always wants. This removes the row outright and is refused
// unless nothing anywhere references it.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  // Body or query string, and an absent flag is never defaulted — see
  // `readDeleteInput`, which is shared with the sibling reference-row
  // deletes because all three read the flag identically.
  const deleteInput = await readDeleteInput(request, requestId);
  if (!deleteInput.ok) return deleteInput.response;
  const body = deleteInput.body;

  try {
    const result = await service.call("delete_repo", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
