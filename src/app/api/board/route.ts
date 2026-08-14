// The HTTP adapter's board endpoint — SCHEMA.md §19 `GET /board`: "Items
// grouped by derived column." §22: "a thin shell over one service call" —
// this route opens no transaction, resolves no settings, and imports no
// database client, same shape as `src/app/api/items/route.ts`.
//
// Human-facing only (§22 assertion 4 names the board as a waived MCP/CLI
// operation — "the board is a user-interface read") — but it still runs
// through the same `service.call` seam every other adapter uses, so the
// grouping and filter logic live in exactly one place.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../items/respond";
import { parseBooleanParam } from "../_shared/query";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  const priority = url.searchParams.get("priority");
  if (priority !== null) input.priority = priority;
  const area = url.searchParams.get("area");
  if (area !== null) input.area = area;
  const repo = url.searchParams.get("repo");
  if (repo !== null) input.repo = repo;
  const kind = url.searchParams.get("kind");
  if (kind !== null) input.kind = kind;
  const state = url.searchParams.get("state");
  if (state !== null) input.state = state;
  const assignee = url.searchParams.get("assignee");
  if (assignee !== null) input.assignee = assignee;
  const search = url.searchParams.get("search");
  if (search !== null) input.search = search;
  const includeTerminal = url.searchParams.get("includeTerminal");
  if (includeTerminal !== null) input.includeTerminal = parseBooleanParam(includeTerminal);

  try {
    const board = await service.call("get_board", input, { caller: { transport: "http" } });
    return NextResponse.json({ board });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
