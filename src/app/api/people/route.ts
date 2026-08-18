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
import { httpCaller, withRequestId, serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const { requestId, caller } = httpCaller(request);
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("includeArchived");
  const input: Record<string, unknown> = {};
  if (includeArchived !== null) input.includeArchived = includeArchived === "true";

  try {
    const result = await service.call("list_people", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
