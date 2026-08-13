// The HTTP adapter's single-machine endpoint — SCHEMA.md §19
// `GET /machines/{name}`, `PATCH /machines/{name}`. MILESTONES.md #92.
// `PATCH` upserts — see `update-machine.ts`'s header.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, readJsonBody, serviceErrorResponse } from "../../admin-respond";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const machine = await service.call("get_machine", { name }, { caller: { transport: "http" } });
    return NextResponse.json({ machine });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const machine = await service.call(
      "update_machine",
      { ...body, name },
      { caller: { transport: "http" } },
    );
    return NextResponse.json({ machine });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
