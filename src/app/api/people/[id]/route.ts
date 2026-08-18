// The HTTP adapter's single-person endpoint — SCHEMA.md §19 `/people`,
// §8a. MILESTONES.md #116.
//
// `PATCH` upserts — see `update-person.ts`'s header for why `people` is
// spelled as one upsert like `machines` and `accounts` rather than as a
// deliberate `POST` like `repos`. This mirrors
// `src/app/api/accounts/[id]/route.ts` exactly, including taking the id
// from the path and overriding any id in the body with it, so the URL is
// the single source of truth for which row is being written.
//
// A thin shell over `service.call` (SCHEMA.md §22): opens no transaction,
// resolves no settings snapshot, imports no database client.
//
// There is no `GET` here. `list_people` is the only registered read for
// this entity and it answers for the whole collection; a single-person read
// would need a `get_person` operation, and adding one is not what this row
// is for — an adapter must not reach past the service to synthesise a read
// the service does not have.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../../admin-respond";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse(requestId);

  try {
    const person = await service.call("update_person", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ person }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
