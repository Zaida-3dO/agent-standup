// `/api/ui/*` — the front end's way in.
//
// The browser calls this; this calls the real API with a credential the
// browser never sees. Every reason it works this way is in
// `@/lib/auth/browser-session.ts`; the short version is that the argument
// for bearer tokens is an argument about machines, a browser is not one,
// and anything handed to a browser is readable by whoever opens the
// developer tools.
//
// **This route is in `auth-route-coverage.test.ts`'s unauthenticated list,
// and that is the honest description of it**: it does not authenticate its
// caller. What it does is refuse to serve anything without presenting a
// real credential of its own, to the same gate every other client passes.
// The distinction matters when reading the allowlist — this is not a route
// that reaches data without a token, it is a route whose token is the
// server's rather than the caller's.
//
// ── What this deliberately does not do ───────────────────────────────────
//
// It does not inspect `Origin`, `Sec-Fetch-Site` or a referer, and must not
// be "hardened" by adding that later. Those are values the caller writes,
// so a check on them refuses only clients that are honest about being
// clients — while reading as though it were a boundary. The real boundary
// is which surfaces this forwards to and what credential it holds; a header
// the caller controls adds nothing to either.
//
// It also does not narrow to a list of "safe" paths. A read-only allowlist
// would split the security model by verb — reads exempt, writes not — and
// the front end genuinely writes: it transitions items, edits settings and
// marks events seen. A model where a write is guarded and a read is not is
// one somebody eventually gets subtly wrong; here both take the identical
// path and present the identical credential.
import { NextResponse } from "next/server";
import { browserSessionToken } from "@/lib/auth/browser-session";
import {
  forwardTargetUrl,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  unconfiguredResponseBody,
} from "@/lib/ui-proxy/forward";

/**
 * Never prerendered or cached. Every forwarded call is a live read of
 * mutable state on behalf of one reader, and a cached one would serve a
 * stale board — or worse, one reader's response to another.
 */
export const dynamic = "force-dynamic";

async function forward(request: Request, params: Promise<{ path: string[] }>) {
  const token = browserSessionToken();
  if (token === null) {
    return NextResponse.json(unconfiguredResponseBody(), { status: 503 });
  }

  const { path } = await params;
  const target = forwardTargetUrl(request.url, path ?? []);
  if (target === null) {
    return NextResponse.json(
      { error: { message: "That is not a path this route can forward." } },
      { status: 404 },
    );
  }

  // The body is streamed through as bytes rather than parsed and re-encoded:
  // this route has no opinion about what any endpoint's body means, and
  // re-serialising one would make the forwarding surface a second place
  // where a payload can be subtly altered. `duplex` is required by the fetch
  // standard whenever a body is a stream.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers: forwardedRequestHeaders(request.headers, token),
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    // A redirect followed here would be followed *with the credential
    // attached*, so it is returned to the browser to act on instead.
    redirect: "manual",
    cache: "no-store",
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, ctx.params);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, ctx.params);
}

export async function PATCH(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, ctx.params);
}

export async function PUT(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, ctx.params);
}

export async function DELETE(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, ctx.params);
}
