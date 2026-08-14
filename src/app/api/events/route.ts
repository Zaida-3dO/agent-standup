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
import { serviceErrorResponse } from "../items/respond";
import { parseBooleanParam } from "../_shared/query";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  const since = url.searchParams.get("since");
  if (since !== null) input.since = since;
  const personId = url.searchParams.get("personId");
  if (personId !== null) input.personId = personId;
  const unseenOnly = url.searchParams.get("unseenOnly");
  if (unseenOnly !== null) input.unseenOnly = parseBooleanParam(unseenOnly);

  // `limit` is a number in the schema, so it has to arrive as one. A
  // non-numeric string is forwarded untouched rather than dropped or
  // coerced to a default — the schema then refuses it naming `limit`,
  // which is a better answer than silently serving a different page size
  // than the caller asked for.
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = limit.trim() !== "" && Number.isFinite(parsed) ? parsed : limit;
  }

  try {
    const events = await service.call("get_events", input, { caller: { transport: "http" } });
    return NextResponse.json(events);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
