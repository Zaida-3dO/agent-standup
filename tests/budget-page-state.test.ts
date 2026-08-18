// Fetching and saving `budget.windows` — MILESTONES.md #87.
//
// Driven through the injected `fetchImpl` rather than a global stub, the
// same shape `settings-page/state.ts` and its test use: the function takes
// its transport as an argument, so a test hands it one and asserts on both
// what went out and what came back.
import { describe, expect, it, vi } from "vitest";
import {
  BUDGET_WINDOWS_KEY,
  budgetErrorMessageFrom,
  fetchWindows,
  writeWindows,
} from "@/lib/budget-page/state";

const constant = (value: number) => ({ kind: "constant" as const, value });

const validWindow = {
  enabled: true,
  lengthHours: 5,
  boundaries: { selective: constant(60), windDown: constant(80), stop: constant(95) },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchWindows", () => {
  it("reads the setting by its key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: { main: validWindow } }));
    const windows = await fetchWindows(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/settings/${encodeURIComponent(BUDGET_WINDOWS_KEY)}`,
    );
    expect(windows).toEqual({ main: validWindow });
  });

  // A fresh installation has no windows and that is a valid state, not a
  // failure to load — every setting has a default and this one's is empty.
  it("reads an unset setting as no windows rather than as an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: null }));
    expect(await fetchWindows(fetchImpl as unknown as typeof fetch)).toEqual({});
  });

  // The editor exists to fix a bad configuration, so a stored value that
  // does not parse has to surface — a page that silently showed an empty
  // set would hide the thing the reader came to repair.
  it("refuses a stored value that does not match the shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: { main: { enabled: "yes" } } }));
    await expect(fetchWindows(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /do not match the expected shape/,
    );
  });

  it("carries the service's own sentence out of a failed read", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "no such setting" } }, 404),
    );
    await expect(fetchWindows(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "no such setting",
    );
  });

  it("falls back to the status when the body is not the envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(fetchWindows(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "The write failed (500).",
    );
  });
});

describe("writeWindows", () => {
  it("puts the whole map at the setting's key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const outcome = await writeWindows({ main: validWindow }, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/settings/${encodeURIComponent(BUDGET_WINDOWS_KEY)}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ value: { main: validWindow } });
  });

  // Refused before the request goes out, so an incoherent set costs no round
  // trip — but the server validates it again, because a client-side check is
  // a convenience and never the gate.
  it("refuses an invalid set without calling fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const outcome = await writeWindows(
      { main: { ...validWindow, lengthHours: -1 } },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Crossing boundaries are refused by the model's own `superRefine`, so
  // the editor inherits that check rather than restating it.
  it("refuses a set whose boundaries cross", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const outcome = await writeWindows(
      {
        main: {
          ...validWindow,
          boundaries: { selective: constant(90), windDown: constant(50), stop: constant(95) },
        },
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries the service's own sentence out of a failed write", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid value for budget.windows" } }, 400),
    );
    const outcome = await writeWindows({ main: validWindow }, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: false, message: "Invalid value for budget.windows" });
  });
});

describe("budgetErrorMessageFrom", () => {
  it("keeps a thrown message", () => {
    expect(budgetErrorMessageFrom(new Error("boom"))).toBe("boom");
  });

  it("has something to say about a thrown non-error", () => {
    expect(budgetErrorMessageFrom("nope")).toBe("Could not load the budget windows.");
  });
});
