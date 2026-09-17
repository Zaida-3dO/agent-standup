// The HTTP adapter's single-intervention level endpoint — MILESTONES.md
// #128, `PUT /interventions/{id}/level` and `DELETE /interventions/{id}/level`.
// Thin shell over `service.call` — see ../../settings/route.ts.
//
// **`DELETE` is what "inherit" is, and it is not a `PUT` of the default.**
// The verb carries the whole of `src/lib/interventions/settings.ts`'s rule 1:
// an entry that has never been overridden tracks the product, so returning
// one to that state removes its row rather than writing the current default
// into it. A route that offered only `PUT` would force every surface to
// invent the reset, and the obvious invention — send the default back — is
// the one that silently pins the value for ever.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  invalidJsonResponse,
  serviceErrorResponse,
  withRequestId,
} from "../../../_shared/respond";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("set_intervention_level", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  try {
    const result = await service.call("clear_intervention_level", { id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
