// The HTTP adapter's single-setting endpoint — SCHEMA.md §19
// `GET /settings/{key}`, `PUT /settings/{key}`, `DELETE /settings/{key}`.
// Thin shell over `service.call` — see ../route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, withRequestId, serviceErrorResponse } from "../respond";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { key } = await params;
  try {
    const setting = await service.call("get_setting", { key }, { caller });
    return withRequestId(NextResponse.json(setting), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { key } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return withRequestId(
      NextResponse.json(
        {
          error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const setting = await service.call("put_setting", { ...body, key }, { caller });
    return withRequestId(NextResponse.json(setting), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { key } = await params;
  try {
    const setting = await service.call("delete_setting", { key }, { caller });
    return withRequestId(NextResponse.json(setting), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
