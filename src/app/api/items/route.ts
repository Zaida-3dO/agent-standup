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
import { parseBooleanParam } from "../_shared/query";

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
  const input: Record<string, unknown> = {};

  const state = url.searchParams.get("state");
  if (state !== null) input.state = state;
  const priority = url.searchParams.get("priority");
  if (priority !== null) input.priority = priority;
  const area = url.searchParams.get("area");
  if (area !== null) input.area = area;
  const repo = url.searchParams.get("repo");
  if (repo !== null) input.repo = repo;
  const parentId = url.searchParams.get("parentId");
  if (parentId !== null) input.parentId = parentId === "" ? null : parentId;
  const includeTerminal = url.searchParams.get("includeTerminal");
  if (includeTerminal !== null) input.includeTerminal = parseBooleanParam(includeTerminal);
  // The opt-in out of the slim default (MILESTONES.md #107). Threaded here
  // because an opt-in that exists in the service layer but not in the
  // adapter is not an opt-in for anyone actually calling the product.
  const full = url.searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  const limit = url.searchParams.get("limit");
  if (limit !== null) input.limit = Number(limit);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  try {
    const result = await service.call("list_items", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
