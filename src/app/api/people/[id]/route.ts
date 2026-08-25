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
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../../admin-respond";
import { parseBooleanParam } from "../../_shared/query";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
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

// `DELETE /people/{id}` — the hard delete half of MILESTONES.md #96.
//
// Separate from the `PATCH` above because deleting and archiving are two
// different operations, not one operation with a flag: `PATCH` with
// `archived: true` keeps the row and every reference to it, and is what a
// caller almost always wants. This removes the row outright and is refused
// unless nothing anywhere references it.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  // The body is optional here — `hardDelete` may also arrive as a query
  // parameter, because a `DELETE` with a body is awkward from a browser and
  // from `curl` alike. An absent flag is not defaulted to `true`: the
  // service refuses it, which is the point of requiring it.
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
  if (body.hardDelete === undefined) {
    const flag = new URL(request.url).searchParams.get("hardDelete");
    if (flag !== null) body.hardDelete = parseBooleanParam(flag);
  }

  try {
    const result = await service.call("delete_person", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
