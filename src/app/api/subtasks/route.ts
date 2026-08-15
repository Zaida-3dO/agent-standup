// The HTTP adapter's `subtasks` collection endpoint — `create_subtask`.
//
// `taskId` travels in the body for symmetry with `POST /api/tasks` rather
// than out of necessity: it is always a real id, so a path segment would
// work here. Two sibling collection endpoints that shape their parent
// reference differently would be a difference a caller has to remember for
// no gain, and the shape a caller writes is then the same for all three
// creates.
//
// A thin shell over `service.call` (SCHEMA.md §22).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../items/respond";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    );
  }

  try {
    const item = await service.call("create_subtask", body, { caller: { transport: "http" } });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
