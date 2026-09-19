// The HTTP adapter's `fleet` endpoint — `get_fleet` (M10 T16): every live
// assignment in the installation, in one read.
//
// A thin shell over `service.call` (SCHEMA.md §22): no transaction, no
// settings resolution, no database client — same shape as
// `src/app/api/board/route.ts`.
//
// **No FILTER parameters, but it is paged.** Filtering by machine or by
// agent is a display concern the fleet page applies over the one full list,
// the same split `get_projects` draws between the rollup query and
// `distributionOf`. Paging is not: `get_fleet` declares `limit` and `cursor`
// and its own summary tells callers to "pass limit and cursor, and read
// nextCursor for the following page". This route used to pass a hardcoded
// `{}` — and said in this comment that the operation took no parameters,
// which was false — so `nextCursor` came back on a page nobody could ask
// for, and the second page of the fleet was unreachable over HTTP.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`).
  const input = queryInput(request, "get_fleet");

  try {
    const result = await service.call("get_fleet", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
