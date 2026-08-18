// The HTTP adapter's `projects` collection endpoint — `create_project`.
//
// Its own path rather than a flag on `POST /api/items`, for the reason the
// operation exists at all: which kind is being created is the caller's
// decision, and a REST surface says that with the collection it posts to.
// A reader of an access log can see that a project was created.
//
// A thin shell over `service.call` (SCHEMA.md §22): parse the request into
// an input, call the service, render the result. No transaction, no settings
// resolution, no database client.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, serviceErrorResponse } from "../items/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    );
  }

  try {
    const item = await service.call("create_project", body, { caller });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
