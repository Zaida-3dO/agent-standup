// The HTTP adapter's `search` endpoint — `GET /search` (MILESTONES.md #105).
//
// A thin shell over `service.call` (SCHEMA.md §22: "every way in … is a
// thin shell over one service call"): read the query string into an input,
// call the service, render the result. This route opens no transaction,
// resolves no settings and imports no database client.
//
// **Its own path rather than a parameter on `/items`.** Search asks a
// different question from a filtered list — every state by default, ranked
// rather than ordered, and returning excerpts rather than rows — and
// answers about the whole corpus rather than a slice of it. Folding it into
// the collection endpoint would mean one route whose response shape and
// default state filter both flip on whether one parameter is present, which
// is the kind of overload a caller has to read the implementation to
// predict.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "../items/respond";
import { authenticatedCaller, withRequestId } from "../_shared/respond";
import { queryInput } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  // Read off the operation's own schema (`../_shared/query.ts`) for every
  // field except `query` itself, which is exempted and read separately below
  // because this route accepts two URL spellings (`q` and `query`) for one
  // schema field — a route-specific alias the schema has no way to declare.
  const input = queryInput(request, "search", ["query"]);

  // Read through untouched when absent, so the operation's own schema is
  // what refuses a missing query — with the same code and the same field
  // path every other adapter would produce for the same call.
  const query = url.searchParams.get("q") ?? url.searchParams.get("query");
  if (query !== null) input.query = query;

  try {
    const result = await service.call("search", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
