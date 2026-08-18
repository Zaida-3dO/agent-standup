// The HTTP adapter's complete endpoint (SCHEMA.md §18 "complete… Separate
// from transition on purpose"). Thin shell over `service.call`, same shape
// as every route in this directory.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, serviceErrorResponse } from "../../respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
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
    const result = await service.call("complete_item", { ...body, id }, { caller });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
