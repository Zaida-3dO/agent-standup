// The HTTP adapter's `repos` collection endpoint — SCHEMA.md §19
// `GET /repos`, `POST /repos`. MILESTONES.md #92.
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/items/route.ts`: parse the request into a name and an input,
// call the service, render the result.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
  withRequestId,
  invalidJsonResponse,
  readJsonBody,
  serviceErrorResponse,
} from "../admin-respond";

export async function GET(request: Request) {
  const { requestId, caller } = httpCaller(request);
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("includeArchived");
  const input: Record<string, unknown> = {};
  if (includeArchived !== null) input.includeArchived = includeArchived === "true";

  try {
    const result = await service.call("list_repos", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse(requestId);

  try {
    const repo = await service.call("create_repo", body, { caller });
    return withRequestId(NextResponse.json({ repo }, { status: 201 }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
