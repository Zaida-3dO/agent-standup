// The HTTP adapter's intervention-capture endpoint — MILESTONES.md #128,
// SCHEMA.md §19 `POST /interventions`, machine-facing: beside `/hook` and
// `/tool-calls` because, like them, no session addresses it by name — the
// hook script posts to it, not an agent. Thin shell over `service.call`,
// same shape as every other route here.
//
// **Why this is not folded into `POST /hook`.** `record-intervention.ts`'s
// own header states the reason in full: making `hook_decision` write would
// change the contract of the highest-volume read in the system, for the
// overwhelming majority of calls that trigger nothing. Keeping it a
// separate call also keeps the recording optional in the direction that
// matters — a hook that cannot reach this endpoint still got its decision
// from `/hook`; it loses the evidence loop, not the guard, which is the
// same fail-open posture `/hook` already takes applied to something even
// less critical than the decision itself.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("record_intervention", body, { caller });
    return withRequestId(NextResponse.json(result, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
