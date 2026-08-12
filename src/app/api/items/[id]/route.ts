// The HTTP adapter's single-item endpoint (SCHEMA.md §19 `GET /items/{id}`,
// `PATCH /items/{id}`). Thin shell over `service.call` — see items/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../respond";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const item = await service.call("get_item", { id }, { caller: { transport: "http" } });
    return NextResponse.json({ item });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    );
  }

  try {
    const item = await service.call(
      "update_item",
      { ...body, id },
      { caller: { transport: "http" } },
    );
    return NextResponse.json({ item });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
