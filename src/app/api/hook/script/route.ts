// `GET /api/hook/script?variant=<variant>` — MILESTONES.md #125(b),
// SCHEMA.md §21.
//
// The other half of the bootstrap loop `register_session` starts: a session
// that registers with no hook version is told a URL to fetch (this one) and
// nothing else, "because an MCP response is not the place for a payload
// this size, and a URL also lets a client fetch it with ordinary tooling."
// This route is that URL. It serves the built artefact
// (`scripts/build-hook-scripts.mjs`, read by `@/lib/hook-script-store.ts`)
// for exactly the variant named — never the whole build tree, never a
// listing of what exists.
//
// It is deliberately not a service operation. `service.call` exists to run
// one of the operations in the registry (`src/lib/service/registry.ts`)
// against the database and its guards; this route touches neither — it
// reads a file esbuild already produced and writes its bytes back. The same
// reasoning `src/app/api/health/route.ts` gives for its own plain `GET`
// applies here.
//
// ── Unknown variant: 404, not `invalid_input` ────────────────────────────
//
// This is a `GET`, so there is no request body, no schema, and nothing to
// call `.strict()` against — `invalid_input` is a service-layer refusal of a
// malformed call to an *operation*, and there is no operation here to call
// malformed. What a caller actually did wrong is name something that does
// not exist at this URL, and 404 ("not found") says exactly that, in the
// vocabulary an HTTP client already understands without reading this
// repository's own error taxonomy. `resolveHookScript` collapses "not a
// real variant" and "a real variant with no script built yet" into the same
// `undefined` for the same reason: both mean "there is nothing to send",
// and a caller asking `?variant=cli` gets the same honest 404 a caller
// asking `?variant=carrier-pigeon` gets, rather than a confusing
// 200-with-empty-body or a made-up in-between status.
//
// ── Cacheable? No — deliberately `no-store` ──────────────────────────────
//
// The URL names a variant, not a version (`?variant=http`, never
// `?variant=http&version=3`), and the file behind it changes on every
// release that touches the hook — the exact case `assessVersion`
// (`@/lib/sessions.ts`) exists to detect server-side. A cache sitting in
// front of this route — a browser, a shared proxy, a CDN — would keep
// serving a stale build to a caller re-fetching it after an upgrade, with
// nothing about the *URL* to signal the content changed. That is silently
// worse than no caching at all: the failure mode is a session running an
// old hook while believing it just fetched the current one. If the route is
// ever content-addressed (the URL itself encoding the protocol version),
// long-lived caching becomes correct and cheap; until then `no-store` is the
// only response that cannot go stale.
import { NextResponse } from "next/server";
import { resolveHookScript } from "@/lib/hook-script-store";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const variant = searchParams.get("variant");

  const script = resolveHookScript({ variant });
  if (script === undefined) {
    return NextResponse.json(
      {
        error: {
          code: "not_found",
          message:
            variant === null
              ? "?variant is required, e.g. GET /api/hook/script?variant=http."
              : `No built hook script for variant "${variant}".`,
          fields: ["variant"],
        },
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return new NextResponse(new Uint8Array(script.contents), {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "content-disposition": `attachment; filename="standup-hook-${script.variant}.js"`,
      "cache-control": "no-store",
    },
  });
}
