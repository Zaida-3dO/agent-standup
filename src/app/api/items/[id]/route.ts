// The HTTP adapter's single-item endpoint (SCHEMA.md §19 `GET /items/{id}`,
// `PATCH /items/{id}`). Thin shell over `service.call` — see items/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../respond";
import { parseBooleanParam } from "../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const input: Record<string, unknown> = { id };
  // `?full=true` opts out of the slim default (MILESTONES.md #107).
  const full = new URL(request.url).searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  try {
    const item = await service.call("get_item", input, { caller: { transport: "http" } });
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
