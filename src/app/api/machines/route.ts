// The HTTP adapter's `machines` collection endpoint — SCHEMA.md §19
// `GET /machines`. MILESTONES.md #92. No `POST` — see `update-machine.ts`'s
// header for why creation happens through `PATCH /machines/{name}` instead.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../admin-respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  try {
    const result = await service.call("list_machines", {}, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
