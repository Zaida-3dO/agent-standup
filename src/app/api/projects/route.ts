// The HTTP adapter's `projects` collection endpoint — `create_project` on
// POST, and the rolled-up project list (`get_projects`, MILESTONES.md #74)
// on GET.
//
// Its own path rather than a flag on `POST /api/items`, for the reason the
// operation exists at all: which kind is being created is the caller's
// decision, and a REST surface says that with the collection it posts to.
// A reader of an access log can see that a project was created.
//
// The read lives on the same collection because it is the same collection:
// `GET /api/projects` returning the projects that `POST /api/projects`
// creates is the shape a reader already expects, and splitting the read
// onto a second path would make the pair harder to find than to use.
//
// Both are thin shells over `service.call` (SCHEMA.md §22): parse the
// request into an input, call the service, render the result. No
// transaction, no settings resolution, no database client.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`) rather than
  // by hand — this route read 4 of the 6 declared fields and never
  // mentioned `limit` or `cursor`, so `nextCursor` named a page no HTTP
  // caller could request. `list_people`'s route had the identical bug and
  // was fixed by reading `limit`/`cursor` explicitly; this closes it the
  // structural way instead, so the operation's next paged field cannot be
  // dropped the same way.
  const input = queryInput(request, "get_projects");

  try {
    const result = await service.call("get_projects", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withRequestId(
      NextResponse.json(
        {
          error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const item = await service.call("create_project", body, { caller });
    return withRequestId(NextResponse.json({ item }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
