// The gate's behaviour, called rather than read.
//
// `tests/auth-route-coverage.test.ts` proves every route is wired to the
// gate by reading the tree; this file proves the gate does what wiring it
// is supposed to achieve — that an unauthenticated call is refused with a
// 401 that says why, and never reaches the service layer.
//
// The service is mocked and asserted *not* to have been called. That is the
// assertion worth having: a route that returned 401 after already writing
// to the database would pass a status-only check while doing the exact
// thing the gate exists to prevent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKENS_ENV_VAR } from "@/lib/auth";

const serviceCall = vi.fn();

vi.mock("@/lib/service/live", () => ({
  service: {
    call: (...args: unknown[]) => serviceCall(...args),
  },
}));

/** Builds a request carrying the given Authorization header, if any. */
function request(url: string, authorization?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return new Request(url, { ...init, headers });
}

const TOKEN = "token-for-tests";

beforeEach(() => {
  serviceCall.mockReset();
  serviceCall.mockResolvedValue({ items: [] });
  vi.stubEnv(AUTH_TOKENS_ENV_VAR, `laptop:${TOKEN}`);
});

describe("an authenticated route", () => {
  it("refuses a request with no token, and does not call the service", async () => {
    const { GET } = await import("@/app/api/items/route");

    const response = await GET(request("http://localhost/api/items"));

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("refuses a request with an unrecognised token, and does not call the service", async () => {
    const { GET } = await import("@/app/api/items/route");

    const response = await GET(request("http://localhost/api/items", "Bearer wrong"));

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("serves a request presenting a configured token", async () => {
    const { GET } = await import("@/app/api/items/route");

    const response = await GET(request("http://localhost/api/items", `Bearer ${TOKEN}`));

    expect(response.status).toBe(200);
    expect(serviceCall).toHaveBeenCalledOnce();
  });

  it("hands the service the machine the token proved", async () => {
    const { GET } = await import("@/app/api/items/route");

    await GET(request("http://localhost/api/items", `Bearer ${TOKEN}`));

    const [, , options] = serviceCall.mock.calls[0] as [
      string,
      unknown,
      { caller: { machine?: string } },
    ];
    expect(options.caller.machine).toBe("laptop");
  });

  it("refuses a write with no token before the service is reached", async () => {
    // A write is the case the row is actually about: an unauthenticated
    // caller must not be able to move an item.
    const { POST } = await import("@/app/api/items/route");

    const response = await POST(
      request("http://localhost/api/items", undefined, {
        method: "POST",
        body: JSON.stringify({ title: "anything" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("refuses every call when no tokens are configured at all", async () => {
    vi.stubEnv(AUTH_TOKENS_ENV_VAR, "");
    const { GET } = await import("@/app/api/items/route");

    const response = await GET(request("http://localhost/api/items", `Bearer ${TOKEN}`));

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });
});

describe("the 401 body", () => {
  it("tells a caller that sent nothing to send a bearer token", async () => {
    const { GET } = await import("@/app/api/items/route");

    const response = await GET(request("http://localhost/api/items"));
    const body = await response.json();

    expect(body.error.message).toMatch(/bearer token/i);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer /);
  });

  it("distinguishes an unrecognised token from a missing one", async () => {
    const { GET } = await import("@/app/api/items/route");

    const missing = await (await GET(request("http://localhost/api/items"))).json();
    const invalid = await (await GET(request("http://localhost/api/items", "Bearer wrong"))).json();

    expect(missing.error.message).not.toBe(invalid.error.message);
    expect(invalid.error.message).toMatch(/not recognised/i);
  });

  it("names no machine and no token in either refusal", async () => {
    const { GET } = await import("@/app/api/items/route");

    for (const header of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`]) {
      const body = await (await GET(request("http://localhost/api/items", header))).json();
      const rendered = JSON.stringify(body);

      expect(rendered).not.toContain("laptop");
      expect(rendered).not.toContain(TOKEN);
    }
  });
});

describe("the MCP mount", () => {
  it("refuses an unauthenticated request", async () => {
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(
      request("http://localhost/api/mcp", undefined, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("refuses a request with an unrecognised token", async () => {
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(
      request("http://localhost/api/mcp", "Bearer wrong", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(serviceCall).not.toHaveBeenCalled();
  });
});

describe("the unauthenticated probes stay reachable", () => {
  it("liveness answers with no token", async () => {
    const { GET } = await import("@/app/api/health/route");

    expect((await GET()).status).toBe(200);
  });

  it("readiness answers with no token", async () => {
    serviceCall.mockResolvedValue({
      ready: true,
      database: true,
      migrationsApplied: 3,
      migrationsPending: 0,
    });
    const { GET } = await import("@/app/api/ready/route");

    const response = await GET(request("http://localhost/api/ready"));

    expect(response.status).toBe(200);
  });
});
