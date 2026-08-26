// `POST /api/areas/merge` — `merge_areas`. A named sub-route rather than a
// flag on `PATCH /areas/{id}`, matching `../../items/[id]/reparent/route.ts`
// and `../../items/[id]/retype/route.ts`: this call touches every item that
// held the losing area plus both `Area` rows, which is a different shape of
// write from renaming or archiving one row, and it is refused the same way
// those two are — see `merge_areas`' own header for the reasoning.
//
// A thin shell over `service.call` (SCHEMA.md §22): validation, guards and
// the de-duplication pass all live in the operation.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../../admin-respond";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse(requestId);

  try {
    const result = await service.call("merge_areas", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
