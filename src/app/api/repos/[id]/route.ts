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
import { parseBooleanParam } from "../../_shared/query";

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

  // The body is optional here — `hardDelete` may also arrive as a query
  // parameter, because a `DELETE` with a body is awkward from a browser and
  // from `curl` alike. An absent flag is not defaulted to `true`: the
  // service refuses it, which is the point of requiring it.
  let body: Record<string, unknown> = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return invalidJsonResponse(requestId);
    }
  }
  if (body.hardDelete === undefined) {
    const flag = new URL(request.url).searchParams.get("hardDelete");
    if (flag !== null) body.hardDelete = parseBooleanParam(flag);
  }

  try {
    const result = await service.call("delete_repo", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
