// The HTTP adapter's people endpoint — SCHEMA.md §19 `GET /people`:
// "Profiles. Archive rather than delete; attribution rows point here."
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/board/route.ts`: opens no transaction, resolves no settings
// snapshot itself, imports no database client. This is the read the
// front-end profile picker (MILESTONES.md #35) calls on load, and — with
// `includeArchived` — what `/admin/people` (T13) calls to show archived
// rows.
//
// No `POST` — creation happens through `PATCH /people/{id}`, the same way
// it does for `machines` and `accounts`. See `update-person.ts`'s header
// (MILESTONES.md #116) for why `people` is one upsert rather than a
// separate deliberate creation verb like `repos`. The profile picker's own
// inline create form (T13) calls that same `PATCH` directly with a
// generated id, rather than this route growing a `POST` that would
// contradict that design decision.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { listInput } from "../_shared/reference-row";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input = listInput(request);
  // `list_people` is paged (MILESTONES.md #109), and this route read only
  // `includeArchived` — so `limit` and `cursor` arrived and were dropped,
  // and a caller asking for one page silently got the default hundred with
  // no `nextCursor` it could act on. Read here the same way
  // `../items/route.ts` reads them, rather than coerced or defaulted:
  // `Number` on a non-numeric string yields `NaN`, which `list_people`'s
  // `z.number().int()` refuses by naming the field — which is the answer
  // the caller wants, and the same one every other adapter gives.
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = Number(limit);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  try {
    const result = await service.call("list_people", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
