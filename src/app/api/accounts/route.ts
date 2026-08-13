// The HTTP adapter's `accounts` collection endpoint — SCHEMA.md §19
// `GET /accounts`. MILESTONES.md #92. No `POST` — see `update-account.ts`'s
// header for why creation happens through `PATCH /accounts/{id}` instead.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../admin-respond";

export async function GET() {
  try {
    const result = await service.call("list_accounts", {}, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
