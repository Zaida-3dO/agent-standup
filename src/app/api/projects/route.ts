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
import { parseBooleanParam } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  const area = url.searchParams.get("area");
  if (area !== null) input.area = area;
  const repo = url.searchParams.get("repo");
  if (repo !== null) input.repo = repo;
  // Finished projects are off by default (the operation's own default); this
  // is how a caller asks for them back. Parsed rather than passed through as
  // a string, because every query param arrives as text and the operation's
  // schema types it as a boolean — handing it the raw string would be
  // rejected as invalid input rather than honoured.
  const includeCompleted = url.searchParams.get("includeCompleted");
  if (includeCompleted !== null) input.includeCompleted = parseBooleanParam(includeCompleted);
  // Archived projects are off by default, the same shape as `includeCompleted`
  // above and for the same reason it is parsed rather than forwarded raw.
  const includeArchived = url.searchParams.get("includeArchived");
  if (includeArchived !== null) input.includeArchived = parseBooleanParam(includeArchived);

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
