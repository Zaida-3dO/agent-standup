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
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../items/respond";
import { queryInput } from "../_shared/query";
import { parseLevelFilter } from "@/lib/board/filters";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  // Read off the operation's own schema (`../_shared/query.ts`) for every
  // field except `level`, whose URL spelling deliberately differs from the
  // operation's own shape (see below) and so is read separately and
  // exempted here. `trust` — documented in `get-board.ts` as the filter
  // answering "show me only the rows I can trust" — is one of the fields
  // this closes: reading every declared field by name means it cannot be
  // absent from a route that reads them all.
  const input = queryInput(request, "get_board", ["level"]);

  // The level filter is the one axis whose URL form is not its service form:
  // the address carries `exclude:0` (one atomic value, so a hand-edited link
  // cannot arrive half-set), while the operation takes `{mode, levels}`. The
  // codec that writes the URL form owns reading it too, so the two cannot
  // drift into disagreeing about the spelling.
  //
  // **`getAll`, not `get`.** A repeated `level=` is a URL a reader can
  // produce — a stale link concatenated with a new one, or a form that
  // submitted twice — and `get` would silently honour the first while
  // ignoring the rest. Reading them all lets the LAST win, which is the
  // behaviour every other "set this filter" path here already has: the most
  // recent choice is the one that applies.
  //
  // An unparseable value is passed to no filter at all rather than refused,
  // matching how the board's own codec treats a bad `priority` — the reader
  // gets a board they can see and correct instead of a 400.
  //
  // **Absent means unnarrowed HERE, which is deliberately NOT what absent
  // means in the codec.** `parseBoardQuery` resolves an absent `level` to
  // `defaultLevelFilter()`, because it is answering "what board is this
  // address showing" and a board has to show something. This adapter is
  // answering "what did the caller ask for", so it passes no level at all
  // and lets `get_board`'s own default — no narrowing — stand. A scripted
  // `GET /api/board` therefore sees every level, including projects, while
  // the same board in the browser does not.
  //
  // The UI never takes that path: `fetchBoardColumn` routes through
  // `boardRequestParams`, which always writes `level` explicitly, default
  // included. Defaulting here instead would silently narrow what a direct
  // API caller gets, which is the opposite of what an adapter should do.
  const levels = url.searchParams.getAll("level");
  const rawLevel = levels[levels.length - 1];
  if (rawLevel !== undefined) {
    const parsed = parseLevelFilter(rawLevel);
    if (parsed !== undefined) input.level = { mode: parsed.mode, levels: [...parsed.levels] };
  }

  try {
    const board = await service.call("get_board", input, { caller });
    return withRequestId(NextResponse.json({ board }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
