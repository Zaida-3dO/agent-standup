// `GET /api` — the index: what this build's HTTP surface actually is.
//
// ── The failure this exists to remove ───────────────────────────────────
//
// Nothing announced the HTTP surface. `GET /api`, `GET /api/docs` and
// `GET /api/openapi.json` were all 404, so a caller holding a valid bearer
// token had no way to ask what it could call.
//
// That is worse than an inconvenience, because the read API is easy to find
// and genuinely useful — `GET /api/items?limit=200&full=true` works on the
// first try — which invites the assumption that a matching write route
// exists at the obvious address. A session reasoning "the read is
// `/api/items`, so the write must be `/api/items/{id}/retype-to-task`" is
// making the most natural inference available to it. A 404 does not correct
// that inference: it is indistinguishable from a typo, an unconfigured
// token, or a real route spelled slightly differently, so the rational
// response is to try again with a variation. One such episode cost 39 failed
// calls and a lost batch of work — while the real route,
// `POST /api/items/{id}/retype`, sat one guess away the whole time.
//
// **An absent route should be discoverable, not inferred from a 404.** That
// is the one thing this route is for: after reading it, "there is no
// retype-to-task endpoint" is a fact a caller can establish in a single call
// rather than a hypothesis it can only ever weakly support by failing.
//
// This matters more than it did. The `put_setting` coercion defect makes
// HTTP the only working path for boolean settings, so callers are actively
// being pushed onto a surface that did not describe itself.
//
// ── Why a route index and not an OpenAPI document ───────────────────────
//
// OpenAPI was the other candidate and would say strictly more: request
// bodies, response shapes, status codes. It was not chosen, for two reasons
// that both come down to what can be kept true automatically.
//
// A faithful OpenAPI document needs per-route request and response schemas.
// The service layer has real schemas — every operation carries a Zod input
// — but the *routes* do not map one-to-one onto operations: several read
// query parameters and assemble the service input themselves
// (`/api/items`'s GET builds its input from eight parameters), so the
// operation's schema is not the route's schema. Deriving the difference
// automatically is not available, and writing it by hand reintroduces
// exactly the hand-maintained document this is supposed to replace — only
// larger, and wrong in more places.
//
// Second, the schemas that *are* derivable are already served. `describe_tool`
// returns any operation's full contract — fields read off the schema it is
// rejected by, plus the conditional rules no schema can state — and it is
// reachable over HTTP. So the marginal thing an OpenAPI document would add
// here is mostly a second, drifting copy of something already answerable.
//
// What was missing was narrower and unserved: *which paths exist at all*.
// This answers that, from a list generated out of the route tree, and points
// at `describe_tool` for the per-operation detail rather than restating it.
//
// ── Why it authenticates ────────────────────────────────────────────────
//
// It goes through the ordinary gate like every other route. The three
// unauthenticated routes are unauthenticated because their callers cannot
// hold a credential — a restart policy, a load balancer, a machine mid-setup.
// Nothing about a route index has that property: every caller of this is a
// configured client asking what it may call next, and it is reachable with
// the same token it already holds. Serving the shape of an installation's
// API to anyone who can open a socket would be a gratuitous disclosure for
// no gain in usability.
import { NextResponse } from "next/server";
import { HTTP_ROUTES } from "@/lib/http-routes.generated";
import { authenticatedCaller, withRequestId } from "./_shared/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId } = auth;

  return withRequestId(
    NextResponse.json({
      // Named so the answer says what it is when it turns up pasted into a
      // terminal with no context around it.
      surface: "agent-standup HTTP API",
      // The one sentence a caller most needs and would otherwise infer
      // wrongly: this list is complete, so a path that is missing from it
      // does not exist. Without this, a reader who cannot find what they
      // want has no way to tell an incomplete index from an absent route,
      // and goes back to guessing — the behaviour this route exists to stop.
      note:
        "Every HTTP route this build serves is listed below. A path that does not appear here " +
        "does not exist — it is not merely undocumented, so retrying it with a different " +
        "spelling will not find it. Each route is a thin shell over one service operation; " +
        "call describe_tool over MCP, or `standup tool describe <name>`, for an operation's " +
        "fields and the conditional rules its schema cannot state.",
      // The generated list. Sorted by path, derived from the route tree, and
      // held to it by `npm run check:http-routes` in CI.
      routes: HTTP_ROUTES,
      count: HTTP_ROUTES.length,
      authentication:
        "Send `Authorization: Bearer <token>` on every route except /api/health, /api/ready " +
        "and /api/hook/script.",
    }),
    requestId,
  );
}
