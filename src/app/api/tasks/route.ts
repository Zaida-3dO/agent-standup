// The HTTP adapter's `tasks` collection endpoint — `create_task`.
//
// `projectId` travels in the body rather than the path (`POST
// /api/projects/{id}/tasks`), because it is required but not always an id:
// the literal `"inbox"` is a legal value meaning "the configured inbox
// project" (see `create-task.ts`). A path segment would make that sentinel
// look like a project whose id is `inbox`, which is exactly the confusion
// the sentinel's own comment warns about; in the body it is a field value
// the operation's schema documents.
//
// A thin shell over `service.call` (SCHEMA.md §22).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";

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
    const item = await service.call("create_task", body, { caller });
    return withRequestId(NextResponse.json({ item }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
