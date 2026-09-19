// The HTTP adapter's `my_work` endpoint (SCHEMA.md §18 `my_work`,
// MILESTONES.md #28). Thin shell over `service.call`, same shape as every
// other route in this adapter — no transaction, no settings, no database
// client import here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`).
  const input = queryInput(request, "my_work");

  try {
    const result = await service.call("my_work", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
