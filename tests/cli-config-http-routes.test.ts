// MILESTONES.md #83 — the `http` binding's route table for `standup config`
// (SCHEMA.md §19). Same shape as `tests/cli-http-binding.test.ts`'s "the
// request the http binding builds" cases, scoped to the four settings
// routes this row adds: `get_settings`, `get_setting`, `put_setting`,
// `delete_setting`.
import { describe, expect, it } from "vitest";
import { createHttpBinding, HTTP_ROUTES } from "@/lib/cli";

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

describe("the settings routes the http binding builds", () => {
  it("`get_settings` reads the collection with no key in the path and no body", async () => {
    const { seen, fetch } = capture(json({ settings: [], revision: "1" }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("get_settings", {});

    expect(seen[0]?.url).toBe("https://example.test/api/settings");
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("`get_setting` puts the key in the path and sends no body", async () => {
    const { seen, fetch } = capture(json({ key: "items.max_depth", value: 6 }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("get_setting", { key: "items.max_depth" });

    expect(seen[0]?.url).toBe("https://example.test/api/settings/items.max_depth");
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("percent-encodes a key with a slash so it cannot reach a different route", async () => {
    const { seen, fetch } = capture(json({}));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("get_setting", { key: "a/b" });
    expect(seen[0]?.url).toBe("https://example.test/api/settings/a%2Fb");
  });

  it("`put_setting` uses PUT, keeps the key out of the body and in the path", async () => {
    const { seen, fetch } = capture(json({ key: "items.max_depth", value: 10 }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("put_setting", { key: "items.max_depth", value: 10 });

    expect(seen[0]?.url).toBe("https://example.test/api/settings/items.max_depth");
    expect(seen[0]?.init.method).toBe("PUT");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ value: 10 });
  });

  it("`put_setting` sends an explicit JSON null value, not an omitted field", async () => {
    // SCHEMA.md §17.2: JSON `null` is a legal, meaningful override value —
    // "explicitly nothing" — and must arrive as an explicit `null`, not be
    // dropped the way an `undefined` body field would be.
    const { seen, fetch } = capture(json({ key: "notify.doc", value: null }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("put_setting", { key: "notify.doc", value: null });

    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ value: null });
  });

  it("`delete_setting` uses DELETE, puts the key in the path, sends no body", async () => {
    const { seen, fetch } = capture(json({ key: "items.max_depth", value: 6 }));
    const binding = createHttpBinding({ baseUrl: "https://example.test", fetch });
    await binding.invoke("delete_setting", { key: "items.max_depth" });

    expect(seen[0]?.url).toBe("https://example.test/api/settings/items.max_depth");
    expect(seen[0]?.init.method).toBe("DELETE");
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("unwraps every settings route's response as-is, matching the direct binding's shape", () => {
    // `src/app/api/settings/**` already returns each operation's raw result
    // (unlike the items routes' `{ item }` wrapper), so unwrap is the
    // identity for all four — asserted directly against the route table
    // rather than through a live round trip, so a future wrapper added here
    // by mistake fails this test instead of silently changing `data`'s shape.
    const body = { anything: "at all" };
    expect(HTTP_ROUTES.get_settings?.unwrap(body)).toBe(body);
    expect(HTTP_ROUTES.get_setting?.unwrap(body)).toBe(body);
    expect(HTTP_ROUTES.put_setting?.unwrap(body)).toBe(body);
    expect(HTTP_ROUTES.delete_setting?.unwrap(body)).toBe(body);
  });
});

describe("the route map covers standup config end to end", () => {
  it("routes every config command's operation (belt-and-braces alongside the generic COMMANDS check)", async () => {
    const { CONFIG_COMMANDS } = await import("@/lib/cli");
    const unrouted = CONFIG_COMMANDS.map((command) => command.operation).filter(
      (operation) => !(operation in HTTP_ROUTES),
    );
    expect(unrouted).toEqual([]);
  });
});
