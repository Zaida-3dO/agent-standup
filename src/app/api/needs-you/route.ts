// The HTTP adapter's "what needs this person" endpoint (T24). Thin shell
// over one `service.call` (SCHEMA.md §22), like every other read route: no
// transaction, no settings, no database client.
//
// This is the endpoint that replaced three `GET /api/items?state=…` calls
// the inbox used to combine in the browser — see `get_needs_you`'s header
// for why the admission rule belongs on this side of the wire.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId } from "../_shared/respond";
import { serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  // Read off the operation's own schema (`../_shared/query.ts`). `personId`
  // is required and simply absent when the caller did not pass it, so the
  // operation's own schema is still what refuses it — this adapter invents
  // no default and serves nobody else's inbox.
  const input = queryInput(request, "get_needs_you");

  try {
    const result = await service.call("get_needs_you", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
