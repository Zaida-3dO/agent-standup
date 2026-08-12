// src/lib/profile/state.ts — the pure half of ProfileProvider.tsx: what the
// fetch's LoadState and the picker-open flag combine into, and the fetch
// itself. No hooks, no DOM — matches this repo's test harness
// (`vitest.config.ts`: `environment: "node"`).
import { describe, expect, it, vi } from "vitest";
import { deriveProfileContextValue, errorMessageFrom, fetchPeople } from "@/lib/profile/state";
import type { Profile } from "@/lib/profile/types";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const people: readonly Profile[] = [userA];

function actions() {
  return { openPicker: () => {}, closePicker: () => {}, choose: () => {} };
}

describe("deriveProfileContextValue", () => {
  it("people is null while loading", () => {
    const value = deriveProfileContextValue({ status: "loading" }, null, false, actions());
    expect(value.people).toBeNull();
  });

  it("people is null on error, even though the error state carries no people", () => {
    const value = deriveProfileContextValue(
      { status: "error", message: "boom" },
      null,
      false,
      actions(),
    );
    expect(value.people).toBeNull();
  });

  it("people is the loaded list once status is loaded", () => {
    const value = deriveProfileContextValue({ status: "loaded", people }, null, false, actions());
    expect(value.people).toBe(people);
  });

  it("error is null unless status is exactly error", () => {
    const loading = deriveProfileContextValue({ status: "loading" }, null, false, actions());
    expect(loading.error).toBeNull();
    const loaded = deriveProfileContextValue({ status: "loaded", people }, null, false, actions());
    expect(loaded.error).toBeNull();
  });

  it("error carries the message when status is error", () => {
    const value = deriveProfileContextValue(
      { status: "error", message: "network down" },
      null,
      false,
      actions(),
    );
    expect(value.error).toBe("network down");
  });

  it("passes activeProfile and pickerOpen straight through, unmodified", () => {
    const value = deriveProfileContextValue({ status: "loading" }, userA, true, actions());
    expect(value.activeProfile).toBe(userA);
    expect(value.pickerOpen).toBe(true);

    const value2 = deriveProfileContextValue({ status: "loading" }, null, false, actions());
    expect(value2.activeProfile).toBeNull();
    expect(value2.pickerOpen).toBe(false);
  });

  it("carries the exact action functions through, not copies or no-ops", () => {
    const openPicker = () => {};
    const closePicker = () => {};
    const choose = () => {};
    const value = deriveProfileContextValue({ status: "loading" }, null, false, {
      openPicker,
      closePicker,
      choose,
    });
    expect(value.openPicker).toBe(openPicker);
    expect(value.closePicker).toBe(closePicker);
    expect(value.choose).toBe(choose);
  });
});

describe("errorMessageFrom", () => {
  it("uses an Error's own message", () => {
    expect(errorMessageFrom(new Error("specific reason"))).toBe("specific reason");
  });

  it("falls back to a fixed message for a non-Error throw", () => {
    expect(errorMessageFrom("a string was thrown")).toBe("Could not load profiles.");
    expect(errorMessageFrom(undefined)).toBe("Could not load profiles.");
    expect(errorMessageFrom({ weird: true })).toBe("Could not load profiles.");
  });
});

describe("fetchPeople", () => {
  it("returns the people array from a successful response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ people: [userA] }),
    });
    const result = await fetchPeople(fakeFetch as unknown as typeof fetch);
    expect(result).toEqual([userA]);
    expect(fakeFetch).toHaveBeenCalledWith("/api/people");
  });

  it("throws with the response status when the response is not ok", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchPeople(fakeFetch as unknown as typeof fetch)).rejects.toThrow("503");
  });

  it("propagates a network-level rejection (fetch itself throwing)", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error("network unreachable"));
    await expect(fetchPeople(fakeFetch as unknown as typeof fetch)).rejects.toThrow(
      "network unreachable",
    );
  });
});
