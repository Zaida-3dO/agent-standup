// The HTTP adapter's `GET /activity` endpoint over `get_activity` (T19) —
// the fleet-wide timeline, filtered and paged.
//
// A thin shell over one `service.call`: it opens no transaction, resolves no
// settings, and imports no database client (CLAUDE.md: "Every adapter is a
// thin shell over a service call"). Same shape as `../events/route.ts`.
//
// The only work here is turning a query string back into typed input, which
// is adapter work by SCHEMA.md §22's division — the service layer never
// knows a query string exists. Values this cannot confidently shape are
// passed through as strings so the operation's own schema is the single
// place they are refused, with the same `invalid_input` any other adapter
// would give.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`), including
  // the list filters (`type`, `actorType`, `actorId`, `itemId`, `area`,
  // `sessionId`) via `searchParams.getAll` — derived from the schema rather
  // than a written-out list that could fall out of step with it.
  const input = queryInput(request, "get_activity");

  try {
    const result = await service.call("get_activity", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
