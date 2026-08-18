// The HTTP adapter's `areas` collection endpoint — SCHEMA.md §19
// `GET /areas`, `POST /areas`. MILESTONES.md #92. Same shape as
// ../repos/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  httpCaller,
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
    const result = await service.call("list_areas", input, { caller });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const { requestId, caller } = httpCaller(request);
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const area = await service.call("create_area", body, { caller });
    return NextResponse.json({ area }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
