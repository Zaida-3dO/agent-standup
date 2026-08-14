// src/lib/settings-page/state.ts — the `/settings` load and write
// lifecycle (MILESTONES.md #86).
//
// The load half mirrors `tests/board-view.test.ts`'s treatment of
// `fetchBoard`. The write half is where the confirmation gate is actually
// enforced, and the test that matters most is that a refused write **never
// reaches `fetch`** — a gate evaluated after the request has gone out is not
// a gate.
import { describe, expect, it, vi } from "vitest";
import {
  fetchSettings,
  removeUnrecognised,
  settingsErrorMessageFrom,
  writeSetting,
} from "@/lib/settings-page/state";

const SENSITIVE_KEY = "budget.enabled";
const PLAIN_KEY = "items.max_depth";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("loading", () => {
  it("returns the answer's collections when they are all present", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        settings: [{ key: PLAIN_KEY }],
        unrecognised: [{ key: "old", storedValue: 1 }],
        constants: [{ name: "APP_VERSION", value: "1", meaning: "m" }],
        bootstrap: [{ name: "PORT", set: true, meaning: "m" }],
        revision: "9",
      }),
    );
    const response = await fetchSettings(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings");
    expect(response.revision).toBe("9");
    expect(response.unrecognised).toHaveLength(1);
    expect(response.constants).toHaveLength(1);
    expect(response.bootstrap).toHaveLength(1);
  });

  it("fills in every missing collection, so a partial answer cannot crash the page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const response = await fetchSettings(fetchImpl as unknown as typeof fetch);
    expect(response.settings).toEqual([]);
    expect(response.unrecognised).toEqual([]);
    expect(response.constants).toEqual([]);
    expect(response.bootstrap).toEqual([]);
    expect(response.revision).toBe("0");
  });

  it("throws a message naming the status when the request failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(fetchSettings(fetchImpl as unknown as typeof fetch)).rejects.toThrow("503");
  });

  it("turns a caught non-Error into a readable message", () => {
    expect(settingsErrorMessageFrom("boom")).toBe("Could not load settings.");
    expect(settingsErrorMessageFrom(new Error("specific"))).toBe("specific");
  });
});

describe("the confirmation gate runs before the request, not after", () => {
  it("does not call fetch at all when a guarded key is unconfirmed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcome = await writeSetting(
      { key: SENSITIVE_KEY, verb: "set", value: true, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    // The assertion the whole gate rests on: nothing left the browser.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call fetch when a guarded key's reset is unconfirmed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcome = await writeSetting(
      { key: SENSITIVE_KEY, verb: "reset", typed: "yes" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls fetch once the key is typed exactly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: SENSITIVE_KEY }));
    const outcome = await writeSetting(
      { key: SENSITIVE_KEY, verb: "set", value: true, typed: SENSITIVE_KEY },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lets an ungated key through with nothing typed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: PLAIN_KEY }));
    const outcome = await writeSetting(
      { key: PLAIN_KEY, verb: "set", value: 5, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("what the write actually sends", () => {
  it("PUTs the value to the key's own path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await writeSetting(
      { key: PLAIN_KEY, verb: "set", value: 5, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/settings/${encodeURIComponent(PLAIN_KEY)}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ value: 5 });
  });

  it("sends an explicit null rather than omitting the value key", async () => {
    // `put_setting` refuses a body with no `value` key at all (its `.refine`
    // on `"value" in candidate`), so an omitted field would be rejected as
    // malformed rather than stored as "explicitly nothing".
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await writeSetting(
      { key: "notify.doc", verb: "set", value: null, typed: "notify.doc" },
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect("value" in body).toBe(true);
    expect(body.value).toBeNull();
  });

  it("DELETEs for a reset, with no body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await writeSetting(
      { key: PLAIN_KEY, verb: "reset", typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/settings/${encodeURIComponent(PLAIN_KEY)}`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("escapes a key that would otherwise change the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await writeSetting(
      { key: "a/b", verb: "set", value: 1, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/settings/a%2Fb");
  });
});

describe("what the write reports back", () => {
  it("shows the service's own message, which names the bound it refused", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "invalid_input", message: "Invalid value for items.max_depth: too big" } },
        { status: 400 },
      ),
    );
    const outcome = await writeSetting(
      { key: PLAIN_KEY, verb: "set", value: 999, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("too big");
  });

  it("falls back to the status when the body is not the error envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 500 }));
    const outcome = await writeSetting(
      { key: PLAIN_KEY, verb: "set", value: 1, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("500");
  });

  it("falls back to the status when the envelope carries an empty message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "invalid_input", message: "" } }, { status: 400 }),
    );
    const outcome = await writeSetting(
      { key: PLAIN_KEY, verb: "set", value: 1, typed: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("400");
  });
});

describe("removing an unrecognised row", () => {
  it("uses its own endpoint, not the declared-key one", async () => {
    // `DELETE /api/settings/{key}` refuses an undeclared key — which is the
    // whole population of that section.
    const fetchImpl = vi.fn(async () => jsonResponse({ key: "old.key" }));
    const outcome = await removeUnrecognised("old.key", fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/unrecognised/old.key");
    expect(init.method).toBe("DELETE");
  });

  it("reports the service's message when the removal is refused", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "No stored override row for old.key." } }, { status: 404 }),
    );
    const outcome = await removeUnrecognised("old.key", fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("No stored override row");
  });
});
