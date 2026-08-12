// src/lib/profile/storage.ts — the browser-persistence half of
// MILESTONES.md #35 ("remembered in the browser"). Pure, DI'd against a
// fake `KeyValueStorage` — no DOM needed, matching this repo's
// `environment: "node"` test harness (vitest.config.ts).
import { describe, expect, it } from "vitest";
import {
  PROFILE_STORAGE_KEY,
  clearStoredProfileId,
  readStoredProfileId,
  writeStoredProfileId,
  type KeyValueStorage,
} from "@/lib/profile/storage";

/** A minimal in-memory stand-in for `window.localStorage`. */
function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("readStoredProfileId", () => {
  it("returns null when nothing is stored", () => {
    expect(readStoredProfileId(fakeStorage())).toBeNull();
  });

  it("returns the stored id when one is present", () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: "user-a" });
    expect(readStoredProfileId(storage)).toBe("user-a");
  });

  it("reads under the exact documented key, not a different one", () => {
    const storage = fakeStorage({ "some-other-key": "user-a" });
    expect(readStoredProfileId(storage)).toBeNull();
  });

  it("treats an empty stored string as nothing stored", () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: "" });
    expect(readStoredProfileId(storage)).toBeNull();
  });

  it("returns null when storage itself is unavailable (server rendering)", () => {
    expect(readStoredProfileId(undefined)).toBeNull();
  });
});

describe("writeStoredProfileId", () => {
  it("writes the id under the documented key", () => {
    const storage = fakeStorage();
    writeStoredProfileId("user-b", storage);
    expect(storage.data[PROFILE_STORAGE_KEY]).toBe("user-b");
  });

  it("overwrites an id that is already stored, rather than merging", () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: "user-a" });
    writeStoredProfileId("user-b", storage);
    expect(readStoredProfileId(storage)).toBe("user-b");
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => writeStoredProfileId("user-a", undefined)).not.toThrow();
  });
});

describe("clearStoredProfileId", () => {
  it("removes a stored id", () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: "user-a" });
    clearStoredProfileId(storage);
    expect(readStoredProfileId(storage)).toBeNull();
  });

  it("does not throw when nothing was stored", () => {
    const storage = fakeStorage();
    expect(() => clearStoredProfileId(storage)).not.toThrow();
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => clearStoredProfileId(undefined)).not.toThrow();
  });
});

describe("round trip", () => {
  it("write then read returns exactly what was written", () => {
    const storage = fakeStorage();
    writeStoredProfileId("user-a", storage);
    expect(readStoredProfileId(storage)).toBe("user-a");
    writeStoredProfileId("user-b", storage);
    expect(readStoredProfileId(storage)).toBe("user-b");
    clearStoredProfileId(storage);
    expect(readStoredProfileId(storage)).toBeNull();
  });
});
