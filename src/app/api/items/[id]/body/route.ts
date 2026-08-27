// The HTTP adapter's paged item-body endpoint (row 977dc07e). Thin shell
// over one `service.call`, exactly like `items/[id]/history/route.ts`
// beside it (SCHEMA.md §22: "every way in … is a thin shell over one
// service call"): resolve the request into a name and an input, call the
// service, shape the result for the transport. No transaction opened, no
// settings resolved, no database client imported.
//
// Separate from `detail` and from the plain item route rather than a
// parameter on either — see `get_item_body`'s own header for why a second
// concern gets a second read.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../respond";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { id };

  // Each parameter is passed through when present and omitted entirely when
  // absent, so the operation's own defaults apply rather than this adapter
  // re-declaring them. A non-numeric value is passed through as-is for the
  // schema to reject — an adapter that silently swallowed it would turn a
  // caller's mistake into a surprising default instead of an error naming
  // the field.
  const offset = url.searchParams.get("offset");
  if (offset !== null) {
    const parsed = Number(offset);
    input.offset = Number.isNaN(parsed) ? offset : parsed;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = Number.isNaN(parsed) ? limit : parsed;
  }

  try {
    const body = await service.call("get_item_body", input, { caller });
    return withRequestId(NextResponse.json(body), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
