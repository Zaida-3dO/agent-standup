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
import { parseBooleanParam } from "../_shared/query";

/**
 * The filters that take a list.
 *
 * Read with `getAll`, so `?type=note&type=claim` is the two-value filter it
 * looks like. A comma-split would be the other obvious reading and is not
 * used, because the values include ids that may legitimately contain a
 * comma — splitting would silently turn one id into two that match nothing,
 * which reads as "no activity" rather than as an error.
 *
 * Omitted entirely when absent rather than sent as `[]`: the schema treats
 * absent as "every value" and refuses an empty array, so passing one through
 * would turn "no filter" into a refusal.
 */
const LIST_FILTERS = ["type", "actorType", "actorId", "itemId", "area", "sessionId"] as const;

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  for (const name of LIST_FILTERS) {
    const values = url.searchParams.getAll(name);
    if (values.length > 0) input[name] = values;
  }

  const personId = url.searchParams.get("personId");
  if (personId !== null) input.personId = personId;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  for (const name of ["unseenOnly", "full"] as const) {
    const raw = url.searchParams.get(name);
    if (raw !== null) input[name] = parseBooleanParam(raw);
  }

  // `limit` is a number in the schema, so it has to arrive as one. A
  // non-numeric string is forwarded untouched rather than dropped or coerced
  // to a default — the schema then refuses it naming `limit`, which is a
  // better answer than silently serving a different page size than asked
  // for. Same treatment as `../events/route.ts`.
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = limit.trim() !== "" && Number.isFinite(parsed) ? parsed : limit;
  }

  try {
    const result = await service.call("get_activity", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
