// The HTTP adapter's `repos` collection endpoint — SCHEMA.md §19
// `GET /repos`, `POST /repos`. MILESTONES.md #92.
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/items/route.ts`: parse the request into a name and an input,
// call the service, render the result.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, readJsonBody, serviceErrorResponse } from "../admin-respond";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("includeArchived");
  const input: Record<string, unknown> = {};
  if (includeArchived !== null) input.includeArchived = includeArchived === "true";

  try {
    const result = await service.call("list_repos", input, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const repo = await service.call("create_repo", body, { caller: { transport: "http" } });
    return NextResponse.json({ repo }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
