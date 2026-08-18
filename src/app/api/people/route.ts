// The HTTP adapter's people endpoint — SCHEMA.md §19 `GET /people`:
// "Profiles. Archive rather than delete; attribution rows point here."
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/board/route.ts`: opens no transaction, resolves no settings
// snapshot itself, imports no database client. This is the read the
// front-end profile picker (MILESTONES.md #35) calls on load.
//
// No `POST` — creation happens through `PATCH /people/{id}`, the same way
// it does for `machines` and `accounts`. See `update-person.ts`'s header
// (MILESTONES.md #116) for why `people` is one upsert rather than a
// separate deliberate creation verb like `repos`.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, serviceErrorResponse } from "../items/respond";

export async function GET(request: Request) {
  const { requestId, caller } = httpCaller(request);
  try {
    const result = await service.call("list_people", {}, { caller });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
