// The HTTP adapter's single-area endpoint — SCHEMA.md §19 `GET /areas/{id}`,
// `PATCH /areas/{id}`. MILESTONES.md #92. Same shape as ../../repos/[id]/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, readJsonBody, serviceErrorResponse } from "../../admin-respond";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const area = await service.call("get_area", { id }, { caller: { transport: "http" } });
    return NextResponse.json({ area });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const area = await service.call(
      "update_area",
      { ...body, id },
      { caller: { transport: "http" } },
    );
    return NextResponse.json({ area });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
