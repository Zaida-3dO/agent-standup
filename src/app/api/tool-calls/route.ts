// The HTTP adapter's tool-call ingest endpoint — MILESTONES.md #50,
// SCHEMA.md §10 (`tool_calls`). Thin shell over `service.call`, the same
// shape as every other route here.
//
// Machine-facing, and it sits beside `POST /hook` rather than under
// `/items` deliberately: a batch is keyed on a *session*, not an item, and
// a ghost session has no item to nest under (§10 — `item_id` is "Null for a
// **ghost session** — real work with no minted task"). Nesting it would
// make the untracked-work case unrepresentable in the URL.
//
// `201` rather than `200`: the call creates rows. The body reports how many
// and what they were attributed to, so a client can see it hit a ghost
// session — the one outcome that is easy to cause by accident (flushing
// after release) and completely silent otherwise.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  httpCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("record_tool_calls", body, {
      caller,
    });
    return withRequestId(NextResponse.json(result, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
