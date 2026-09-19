// The HTTP adapter's `items` collection endpoint (SCHEMA.md §19).
//
// A thin shell over `service.call` (SCHEMA.md §22: "every way in … is a
// thin shell over one service call"): parse the request into a name and an
// input, call the service, render the result. This route opens no
// transaction, resolves no settings, and imports no database client — it
// cannot, because it never imports anything from `@/lib/prisma` or
// `@/lib/service/live`'s composition beyond the single `service` instance
// every adapter shares.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "./respond";
import { authenticatedCaller, withRequestId } from "../_shared/respond";
import { queryInput } from "../_shared/query";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withRequestId(
      NextResponse.json(
        {
          error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const item = await service.call("create_item", body, { caller });
    return withRequestId(NextResponse.json({ item }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  // Read off the operation's own schema (`../_shared/query.ts`) for every
  // field except `parentId`, exempted and read separately below: `?parentId=`
  // (empty) is this adapter's spelling of "top-level only" and must become
  // `null`, not the empty string the schema's `min(1)` would refuse.
  const input = queryInput(request, "list_items", ["parentId"]);
  const parentId = url.searchParams.get("parentId");
  if (parentId !== null) input.parentId = parentId === "" ? null : parentId;

  try {
    const result = await service.call("list_items", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
