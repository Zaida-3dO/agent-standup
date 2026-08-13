// The HTTP adapter's single-account endpoint — SCHEMA.md §19
// `GET /accounts/{id}`, `PATCH /accounts/{id}`. MILESTONES.md #92.
// `PATCH` upserts — see `update-account.ts`'s header. This is also where
// `vendor` gets checked against the registered adapter list on write
// (SCHEMA.md §23.2) — enforced by the service operation, not this shell.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, readJsonBody, serviceErrorResponse } from "../../admin-respond";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const account = await service.call("get_account", { id }, { caller: { transport: "http" } });
    return NextResponse.json({ account });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJsonBody(request);
  if (body === null) return invalidJsonResponse();

  try {
    const account = await service.call(
      "update_account",
      { ...body, id },
      { caller: { transport: "http" } },
    );
    return NextResponse.json({ account });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
