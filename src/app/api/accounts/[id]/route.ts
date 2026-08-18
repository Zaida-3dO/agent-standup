// The HTTP adapter's single-account endpoint — SCHEMA.md §19
// `GET /accounts/{id}`, `PATCH /accounts/{id}`. MILESTONES.md #92.
// `PATCH` upserts — see `update-account.ts`'s header. This is also where
// `vendor` gets checked against the registered adapter list on write
// (SCHEMA.md §23.2) — enforced by the service operation, not this shell.
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
    const account = await service.call("get_account", { id }, { caller });
    return withRequestId(NextResponse.json({ account }), requestId);
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
    const account = await service.call("update_account", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ account }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
