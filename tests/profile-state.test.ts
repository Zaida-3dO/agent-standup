// src/lib/profile/state.ts — the pure half of ProfileProvider.tsx: what the
// fetch's LoadState and the picker-open flag combine into, and the fetch
// itself. No hooks, no DOM — matches this repo's test harness
// (`vitest.config.ts`: `environment: "node"`).
import { describe, expect, it, vi } from "vitest";
import {
  deriveProfileContextValue,
  errorMessageFrom,
  fetchPeople,
  withPersonAdded,
} from "@/lib/profile/state";
import type { Profile } from "@/lib/profile/types";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: null, colour: null };
const people: readonly Profile[] = [userA];

function actions() {
  return { openPicker: () => {}, closePicker: () => {}, choose: () => {}, addPerson: () => {} };
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
    const addPerson = () => {};
    const value = deriveProfileContextValue({ status: "loading" }, null, false, {
      openPicker,
      closePicker,
      choose,
      addPerson,
    });
    expect(value.openPicker).toBe(openPicker);
    expect(value.closePicker).toBe(closePicker);
    expect(value.choose).toBe(choose);
    expect(value.addPerson).toBe(addPerson);
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

describe("withPersonAdded", () => {
  it("appends the person to a loaded list", () => {
    const result = withPersonAdded({ status: "loaded", people: [userA] }, userB);
    expect(result).toEqual({ status: "loaded", people: [userA, userB] });
  });

  it("appends to an empty loaded list — the first-profile-ever case T21 fixes", () => {
    const result = withPersonAdded({ status: "loaded", people: [] }, userA);
    expect(result).toEqual({ status: "loaded", people: [userA] });
  });

  it("does not mutate the original people array", () => {
    const original: readonly Profile[] = [userA];
    withPersonAdded({ status: "loaded", people: original }, userB);
    expect(original).toEqual([userA]);
  });

  it("is a no-op while still loading", () => {
    const loading = { status: "loading" as const };
    expect(withPersonAdded(loading, userA)).toBe(loading);
  });

  it("is a no-op on an error state", () => {
    const errored = { status: "error" as const, message: "boom" };
    expect(withPersonAdded(errored, userA)).toBe(errored);
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
    expect(fakeFetch).toHaveBeenCalledWith("/api/ui/people");
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
