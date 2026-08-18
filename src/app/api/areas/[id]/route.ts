// The HTTP adapter's single-area endpoint — SCHEMA.md §19 `GET /areas/{id}`,
// `PATCH /areas/{id}`. MILESTONES.md #92. Same shape as ../../repos/[id]/route.ts.
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
    const area = await service.call("get_area", { id }, { caller });
    return withRequestId(NextResponse.json({ area }), requestId);
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
    const area = await service.call("update_area", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ area }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
