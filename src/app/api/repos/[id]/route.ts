// The HTTP adapter's single-repo endpoint — SCHEMA.md §19 `GET /repos/{id}`,
// `PATCH /repos/{id}`. Thin shell over `service.call` — see ../route.ts.
// MILESTONES.md #92.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, readJsonBody, serviceErrorResponse } from "../../admin-respond";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const repo = await service.call("get_repo", { id }, { caller: { transport: "http" } });
    return NextResponse.json({ repo });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const repo = await service.call(
      "update_repo",
      { ...body, id },
      { caller: { transport: "http" } },
    );
    return NextResponse.json({ repo });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
