// `POST /api/items/{id}/restore` — `restore_item`, the inverse `delete_item`
// never had.
//
// A named path rather than a field on `PATCH /api/items/{id}`, for the same
// reason `reparent` and `retype` beside it get one: it is a lifecycle write
// with its own guards, not a column edit. Folding it into the patch body
// would put "bring this row back" next to "change its title" and give the
// two the same shape, when only one of them can refuse because a parent is
// archived.
//
// `POST` rather than `DELETE`-with-a-flag or `PATCH`: it is a named action on
// a subresource, matching every other item action route here, and it is not
// idempotent in the sense a `PUT` would promise — though it is safe to
// repeat, which is a property of the operation rather than of the method.
//
// A thin shell over `service.call` (SCHEMA.md §22). The undo affordance is
// this route's first caller: after an archive, pressing Undo posts here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serviceErrorResponse,
} from "../../../_shared/respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  // An empty body is the ordinary call — `acknowledgeSuperseded` defaults to
  // false and `id` comes from the path — so a request with no body at all is
  // valid rather than malformed. Only a body that is present and unparseable
  // is an error, which is why the `catch` distinguishes them.
  let body: Record<string, unknown> = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return invalidJsonResponse(requestId);
    }
  }

  try {
    const result = await service.call("restore_item", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
