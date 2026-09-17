// The `backfill` route in the command line's HTTP binding
// (`src/lib/cli/bindings/http.ts`, built from `cli-routes.generated.ts`).
//
// **Why this file exists.** The r06 review of PR #79 found that nothing
// under `tests/` imported `BACKFILL_HTTP_ROUTES` or exercised the route:
// its request shape was asserted only implicitly, by an integration run
// that had to have a server. These are direct tests of the route spec and
// of the request the binding actually builds from it.
//
// Pure — `fetch` is a local capture, so nothing leaves the process.
// Every fixture is invented; this repository is public (CLAUDE.md).
import { describe, expect, it } from "vitest";
import { createHttpBinding, HTTP_ROUTES } from "@/lib/cli";
import { GENERATED_ROUTES } from "@/lib/cli/bindings/cli-routes.generated";

function capture(response: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal well-formed payload wrapper — the shape the operation's schema takes. */
const INPUT = {
  payload: { version: 1, defaultArea: "imported", tasks: [] },
};

describe("the `backfill` route, as a table entry", () => {
  it("is present in the binding's route table", () => {
    // The question that matters for a generated map is whether the
    // operation is reachable at all: an absent entry means
    // `standup backfill run --url ...` dispatches to no route and answers
    // `not_implemented`.
    expect(HTTP_ROUTES.backfill).toBeDefined();
  });

  it("is POST — a bulk write, never a GET", () => {
    // Not cosmetic: a payload of this size cannot go in a query string, and
    // a GET carrying a body is not something every intermediary preserves.
    expect(HTTP_ROUTES.backfill?.method).toBe("POST");
  });

  it("sends the whole input as the body, with nothing lifted into the path", () => {
    const built = HTTP_ROUTES.backfill?.request(INPUT);

    expect(built?.path).toBe("/api/backfill");
    // The `{ payload }` wrapper must survive intact: the route's own schema
    // takes it, so unwrapping here would send a shape the server refuses.
    expect(built?.body).toEqual(INPUT);
  });

  it("keeps the path constant regardless of the payload's contents", () => {
    // There is no interpolation in this route, and a test that only ever
    // passed an empty task list would not show that.
    const built = HTTP_ROUTES.backfill?.request({
      payload: { version: 1, defaultArea: "other", tasks: [{ id: "T-1" }] },
    });

    expect(built?.path).toBe("/api/backfill");
  });

  it("returns the response body unwrapped, because the route uses no envelope key", () => {
    const body = { itemsImported: 3, reminder: "still enabled" };

    expect(HTTP_ROUTES.backfill?.unwrap(body)).toBe(body);
  });

  it("is derived from the route tree rather than written by hand", () => {
    // The generated map is the route tree's own account of itself, so
    // pinning the whole entry pins the four facts the binding acts on. It
    // fails if `src/app/api/backfill/route.ts` moves, changes method, or
    // starts lifting a field into its path — each of which would change
    // where this command sends its payload.
    expect(GENERATED_ROUTES.backfill).toEqual({
      method: "POST",
      path: "/api/backfill",
      pathFields: {},
      sendsBody: true,
      unwrapKey: null,
    });
  });
});

describe("the request the http binding builds for `backfill`", () => {
  it("POSTs the payload wrapper to /api/backfill", async () => {
    const { seen, fetch } = capture(json({ itemsImported: 0 }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });

    await binding.invoke("backfill", INPUT);

    expect(seen[0]?.url).toBe("https://example.test/api/backfill");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual(INPUT);
  });

  it("returns the route's result to the caller unwrapped", async () => {
    const result = { itemsImported: 2, itemsSkipped: 1 };
    const { fetch } = capture(json(result));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });

    const invoked = await binding.invoke("backfill", INPUT);

    expect(invoked.ok).toBe(true);
    expect(invoked.ok && invoked.data).toEqual(result);
  });

  it("surfaces the server's refusal when the window is closed rather than inventing one", async () => {
    // "The window is closed" is produced by the service and rendered
    // unedited (the route module's own header). The binding must not
    // pre-empt it: a client-side copy of the gate would drift from the
    // server's.
    const refusal = {
      ok: false,
      error: { code: "not_enabled", message: "Backfill is not enabled." },
    };
    const { fetch } = capture(json(refusal, 403));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });

    const invoked = await binding.invoke("backfill", INPUT);

    expect(invoked.ok).toBe(false);
  });
});
