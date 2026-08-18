// src/lib/profile/create.ts — T13's "create a profile from the empty
// picker". Pure and DOM-free, same reasoning and same technique as
// tests/profile-state.test.ts's fetchPeople coverage.
import { describe, expect, it, vi } from "vitest";
import { createErrorMessage, createPerson, generatePersonId } from "@/lib/profile/create";
import type { Profile } from "@/lib/profile/types";

const created: Profile = {
  id: "generated-id",
  displayName: "Ope",
  avatar: null,
  colour: null,
};

describe("generatePersonId", () => {
  it("returns a non-empty string", () => {
    expect(generatePersonId().length).toBeGreaterThan(0);
  });

  it("returns a DIFFERENT id on each call — never a constant a second create would collide on", () => {
    expect(generatePersonId()).not.toBe(generatePersonId());
  });
});

describe("createPerson", () => {
  it("PATCHes /api/people/{generated id} with the display name", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ person: created }),
    });
    const result = await createPerson(
      "Ope",
      fakeFetch as unknown as typeof fetch,
      () => "fixed-id",
    );

    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/ui/people/fixed-id",
      expect.objectContaining({ method: "PATCH" }),
    );
    const [, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "Ope" });
    expect(result).toEqual(created);
  });

  it("URL-encodes the generated id in the path", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ person: created }) });
    await createPerson("Ope", fakeFetch as unknown as typeof fetch, () => "id with spaces");
    expect(fakeFetch).toHaveBeenCalledWith("/api/ui/people/id%20with%20spaces", expect.anything());
  });

  it("uses a fresh generated id each call when idImpl is not overridden", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ person: created }) });
    await createPerson("A", fakeFetch as unknown as typeof fetch);
    await createPerson("B", fakeFetch as unknown as typeof fetch);
    const firstUrl = (fakeFetch.mock.calls[0] as unknown as [string, RequestInit])[0];
    const secondUrl = (fakeFetch.mock.calls[1] as unknown as [string, RequestInit])[0];
    expect(firstUrl).not.toBe(secondUrl);
  });

  it("throws the service's own message when the response is not ok", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "displayName is required" } }),
    });
    await expect(
      createPerson("", fakeFetch as unknown as typeof fetch, () => "id"),
    ).rejects.toThrow("displayName is required");
  });

  it("falls back to a status-based message when the failed response has no JSON body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(
      createPerson("Ope", fakeFetch as unknown as typeof fetch, () => "id"),
    ).rejects.toThrow("500");
  });

  it("propagates a network-level rejection (fetch itself throwing)", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error("network unreachable"));
    await expect(
      createPerson("Ope", fakeFetch as unknown as typeof fetch, () => "id"),
    ).rejects.toThrow("network unreachable");
  });
});

describe("createErrorMessage", () => {
  it("uses an Error's own message", () => {
    expect(createErrorMessage(new Error("specific reason"))).toBe("specific reason");
  });

  it("falls back to a fixed message for a non-Error throw", () => {
    expect(createErrorMessage("a string was thrown")).toBe("Could not create the profile.");
    expect(createErrorMessage(undefined)).toBe("Could not create the profile.");
  });
});
