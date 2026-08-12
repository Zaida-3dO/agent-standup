// AC4 — the `http` binding's own transport concerns.
//
// The equivalence test (`cli-one-interface.test.ts`) proves the two bindings
// agree; this one covers what only *this* binding can get wrong, because
// there is no `direct` behaviour to compare it against: the request it
// builds, the failure modes of a network, and the promise that a base URL
// never reaches a caller. Those are the cases an equivalence suite is
// structurally unable to catch, which is why they are here rather than
// folded in there.
import { describe, expect, it } from "vitest";
import { HTTP_ROUTES, createHttpBinding } from "@/lib/cli";

/** Captures the request the binding built, and answers with a canned response. */
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

describe("the request the http binding builds", () => {
  it("puts an id in the path and sends no body for a read", async () => {
    const { seen, fetch } = capture(json({ item: { id: "item-1" } }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("get_item", { id: "item-1" });

    expect(seen[0]?.url).toBe("https://example.test/api/items/item-1");
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("percent-encodes an id so a slash in one cannot reach a different route", async () => {
    const { seen, fetch } = capture(json({ item: null }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("get_item", { id: "a/b" });
    expect(seen[0]?.url).toBe("https://example.test/api/items/a%2Fb");
  });

  it("puts filters in the query string for a list", async () => {
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("list_items", { state: "open", limit: 5 });

    const url = new URL(seen[0]?.url as string);
    expect(url.pathname).toBe("/api/items");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("sends a null parentId as the empty string the route reads as top-level", async () => {
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("list_items", { parentId: null });
    expect(new URL(seen[0]?.url as string).searchParams.get("parentId")).toBe("");
  });

  it("keeps the id out of an update's body and in its path", async () => {
    const { seen, fetch } = capture(json({ item: { id: "item-1" } }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("update_item", { id: "item-1", title: "renamed" });

    expect(seen[0]?.url).toBe("https://example.test/api/items/item-1");
    expect(seen[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ title: "renamed" });
  });

  it("tolerates a trailing slash on the base URL rather than doubling it", async () => {
    const { seen, fetch } = capture(json({ item: {} }));
    const binding = createHttpBinding({ baseUrl: "https://example.test///", fetch });
    await binding.invoke("get_item", { id: "x" });
    expect(seen[0]?.url).toBe("https://example.test/api/items/x");
  });

  it("sends the session and actor as headers, never merged into the input", async () => {
    const { seen, fetch } = capture(json({ item: {} }));
    const binding = createHttpBinding({
      baseUrl: "https://example.test",
      fetch,
      sessionId: "s-1",
      actor: "user-a",
    });
    await binding.invoke("create_item", { title: "t" });

    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["X-Standup-Session"]).toBe("s-1");
    expect(headers["X-Standup-Actor"]).toBe("user-a");
    // In the body they would fail the operation schema's `.strict()` parse.
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ title: "t" });
  });
});

describe("how the http binding reads a refusal back", () => {
  it("takes the code from the body, not from the status", async () => {
    // `guard_rejected` and any future code sharing 422 are distinguishable
    // only by the body. A binding recovering the code from the status could
    // not tell them apart, and §22 compares the code.
    const { fetch } = capture(
      json(
        { error: { code: "guard_rejected", message: "no", fields: ["state"], guard: "a_rule" } },
        422,
      ),
    );
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    const result = await binding.invoke("get_item", { id: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toEqual({
      code: "guard_rejected",
      fields: ["state"],
      guard: "a_rule",
    });
  });

  it("treats a body it does not recognise as internal, not as a rule refusing", async () => {
    const { fetch } = capture(new Response("<html>gateway timeout</html>", { status: 504 }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    const result = await binding.invoke("get_item", { id: "x" });

    if (result.ok) throw new Error("unreachable");
    // `internal` exits 1 ("something is broken"), not 3 ("the installation
    // decided"). A proxy's HTML error page must not read as a rule.
    expect(result.rejection.code).toBe("internal");
  });

  it("refuses a code the service taxonomy does not contain", async () => {
    const { fetch } = capture(json({ error: { code: "teapot", message: "no", fields: [] } }, 418));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    const result = await binding.invoke("get_item", { id: "x" });

    if (result.ok) throw new Error("unreachable");
    expect(result.rejection.code).toBe("internal");
  });

  it("reports an unreachable server as internal, without leaking the address", async () => {
    // The thrown error carries the host, the port AND a password, which is
    // exactly the shape a real connect failure has. The binding must render
    // none of it: SCHEMA.md §20, "the connection string … is never printed
    // by any command", and a base URL is this binding's equivalent of one.
    const secretHost = "https://ops:hunter2@standup.private.example:8443";
    const binding = createHttpBinding({
      baseUrl: secretHost,
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${secretHost}`);
      },
    });
    const result = await binding.invoke("get_item", { id: "x" });

    if (result.ok) throw new Error("unreachable");
    expect(result.rejection.code).toBe("internal");
    expect(result.message).toContain("Could not reach the server");
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("standup.private.example");
    expect(result.message).not.toContain("8443");
  });

  it("refuses an operation the API does not route, naming it", async () => {
    const { fetch } = capture(json({}));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    const result = await binding.invoke("no_such_operation", {});

    if (result.ok) throw new Error("unreachable");
    expect(result.rejection.code).toBe("not_implemented");
    expect(result.rejection.fields).toEqual(["operation"]);
  });
});

describe("the route map", () => {
  it("routes every operation the command table calls", async () => {
    // The property that keeps the two bindings' *reach* equal: a command
    // whose operation has no route would work on `direct` and fail on
    // `http`, which is the divergence this row exists to prevent. Waived
    // for `service_info`, which the API exposes through no route — named
    // explicitly, so adding a command without a route still fails here
    // rather than widening the waiver by accident.
    const { COMMANDS } = await import("@/lib/cli");
    const routedElsewhere = new Set(["service_info"]);
    const unrouted = COMMANDS.map((command) => command.operation)
      .filter((operation) => !routedElsewhere.has(operation))
      .filter((operation) => !(operation in HTTP_ROUTES));
    expect(unrouted).toEqual([]);
  });
});
