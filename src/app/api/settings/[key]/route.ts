// The HTTP adapter's single-setting endpoint — SCHEMA.md §19
// `GET /settings/{key}`, `PUT /settings/{key}`, `DELETE /settings/{key}`.
// Thin shell over `service.call` — see ../route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../respond";

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  try {
    const setting = await service.call("get_setting", { key }, { caller: { transport: "http" } });
    return NextResponse.json(setting);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
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
    const setting = await service.call(
      "put_setting",
      { ...body, key },
      { caller: { transport: "http" } },
    );
    return NextResponse.json(setting);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  try {
    const setting = await service.call(
      "delete_setting",
      { key },
      { caller: { transport: "http" } },
    );
    return NextResponse.json(setting);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
