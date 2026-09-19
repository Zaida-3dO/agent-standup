// The HTTP adapter's `GET /events?since=` endpoint — SCHEMA.md §19:
// "Since-your-last-visit. A **slice**, never the whole ledger."
// MILESTONES.md #38.
//
// A thin shell over one `service.call("get_events", …)`: it opens no
// transaction, resolves no settings, and imports no database client
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Same
// shape as `src/app/api/board/route.ts`.
//
// The only work done here is turning a query string back into typed input,
// which is adapter work by §22's division — the service layer never knows a
// query string exists. Values it cannot confidently shape are passed
// through as strings so the operation's own schema is the single place they
// are refused, with the same `invalid_input` any other adapter would give.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`).
  const input = queryInput(request, "get_events");

  try {
    const events = await service.call("get_events", input, { caller });
    return withRequestId(NextResponse.json(events), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
