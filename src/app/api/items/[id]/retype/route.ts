// `POST /api/items/{id}/retype` — `retype_to_task`, the repair that turns a
// childless project into a task under a project (MILESTONES.md #75).
//
// ── Why this needs an HTTP surface at all ───────────────────────────────
//
// `retype_to_task` and `reparent_item` existed only over MCP and the
// command line, which means the one condition the projects grid is built to
// surface — a project with no children, which can never resolve its state
// by any route — was visible on a screen with no way to act on it. A flag a
// reader cannot do anything about trains them to ignore the flag.
//
// ── Why POST to a sub-path rather than PATCH the item ───────────────────
//
// This is not a field edit. It changes an item's position in the tree and
// re-derives its kind and depth, and it refuses on conditions
// (`hierarchy.no_retype_with_children`, `items.max_depth`,
// `hierarchy.no_cycle`) that no ordinary update has. A named path says
// which operation ran, in an access log and in a reader's head, where
// `PATCH /api/items/{id}` with a `kind` in the body would say only that
// something about the item changed.
//
// A thin shell over `service.call` (SCHEMA.md §22).
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
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    // The path parameter wins over anything in the body — spread last, the
    // same order every other route here uses, so a body naming a different
    // item cannot retarget a call made against this path.
    const item = await service.call("retype_to_task", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
