// The HTTP adapter's single-repo endpoint — SCHEMA.md §19 `GET /repos/{id}`,
// `PATCH /repos/{id}`. Thin shell over `service.call` — see ../route.ts.
// MILESTONES.md #92.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../../admin-respond";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  try {
    const repo = await service.call("get_repo", { id }, { caller });
    return withRequestId(NextResponse.json({ repo }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
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
