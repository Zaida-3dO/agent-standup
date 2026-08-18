// A `fetch` that dispatches to the real web-API route handlers, with no
// server. Used by the conformance harness (MILESTONES.md #94, SCHEMA.md §22).
//
// A Next App Router route handler is an exported async function over a
// `Request`, so it can be called directly. That is what makes §22's "run
// in-process wherever the process boundary is not the thing being tested"
// achievable for the web API: a call still leaves as a method, a path and a
// JSON body and comes back as a status and a JSON error envelope — a real
// round trip through the adapter's own serialisation — without binding a
// port. The process boundary is the one thing this does not prove, which is
// why §22 keeps a separate spawned smoke subset for exactly that.
//
// The table below covers the routes the case table exercises rather than all
// of them. That is a deliberate bound: a dispatcher listing every route would
// need an entry added for every new one and would fail as a stale test rather
// than as a real divergence, and the operations it does not cover are
// reported by assertion 4 as an unexposed surface instead of silently
// passing. Add a route here when a case needs it.
import type { NextResponse } from "next/server";

type Handler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

interface RouteEntry {
  /** Matches the path only — the method is chosen from `handlers`. */
  readonly pattern: RegExp;
  readonly handlers: Readonly<Record<string, Handler>>;
  /** Names the capture groups, so a dynamic segment reaches the handler as `params`. */
  readonly params?: readonly string[];
}

let routes: readonly RouteEntry[] | undefined;

/** Narrows a module export to a handler, failing loudly rather than at the call site. */
function handlerFrom(module: Record<string, unknown>, name: string, path: string): Handler {
  const handler = module[name];
  if (typeof handler !== "function") {
    throw new Error(`${path} exports no ${name} handler — the conformance route table is stale`);
  }
  return handler as Handler;
}

/**
 * Loads the route modules once, lazily.
 *
 * Lazily because a route module imports the composition root at module
 * scope, and a suite that mocks it must have done so before this runs —
 * importing at the top of this file would resolve the real one first.
 */
async function loadRoutes(): Promise<readonly RouteEntry[]> {
  if (routes !== undefined) return routes;

  const items = (await import("@/app/api/items/route")) as unknown as Record<string, unknown>;
  const item = (await import("@/app/api/items/[id]/route")) as unknown as Record<string, unknown>;

  const built: readonly RouteEntry[] = [
    {
      pattern: /^\/api\/items$/,
      handlers: {
        GET: handlerFrom(items, "GET", "/api/items"),
        POST: handlerFrom(items, "POST", "/api/items"),
      },
    },
    {
      pattern: /^\/api\/items\/([^/]+)$/,
      handlers: {
        GET: handlerFrom(item, "GET", "/api/items/[id]"),
        PATCH: handlerFrom(item, "PATCH", "/api/items/[id]"),
      },
      params: ["id"],
    },
  ];
  routes = built;
  return built;
}

/**
 * Dispatches one request to a real route handler.
 *
 * An unmatched path returns 404 rather than throwing, because that is what
 * a real server does with one — and a driver that threw here would report
 * an `internal` where the product reports `not_found`, which is exactly the
 * kind of test-only divergence §22 is written to avoid.
 */
export async function routeFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const request = new Request(url, init);
  const method = (init.method ?? "GET").toUpperCase();

  for (const route of await loadRoutes()) {
    const match = route.pattern.exec(parsed.pathname);
    if (match === null) continue;

    const handler = route.handlers[method];
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { message: "method not allowed", code: "not_found", fields: [] } }),
        {
          status: 405,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (route.params === undefined) return handler(request);
    const params: Record<string, string> = {};
    route.params.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? "");
    });
    return handler(request, { params: Promise.resolve(params) });
  }

  return new Response(
    JSON.stringify({ error: { message: "no such route", code: "not_found", fields: [] } }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}
