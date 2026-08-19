// The HTTP adapter's `fleet` endpoint — `get_fleet` (M10 T16): every live
// assignment in the installation, in one read.
//
// A thin shell over `service.call` (SCHEMA.md §22): no transaction, no
// settings resolution, no database client — same shape as
// `src/app/api/board/route.ts`.
//
// No query parameters: the operation takes none (see `get-fleet.ts`'s own
// header — filtering by machine or by agent is a display concern the fleet
// page applies over the one full list, the same split `get_projects`
// draws between the rollup query and `distributionOf`).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;

  try {
    const result = await service.call("get_fleet", {}, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
