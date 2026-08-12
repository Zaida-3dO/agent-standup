// The HTTP adapter's people endpoint — SCHEMA.md §19 `GET /people`:
// "Profiles. Archive rather than delete; attribution rows point here."
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/board/route.ts`: opens no transaction, resolves no settings
// snapshot itself, imports no database client. This is the read the
// front-end profile picker (MILESTONES.md #35) calls on load.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../items/respond";

export async function GET() {
  try {
    const result = await service.call("list_people", {}, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
