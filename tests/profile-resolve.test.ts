// src/lib/profile/resolve.ts — the two cases MILESTONES.md #35 names
// explicitly: "handle the no-profile-chosen-yet and unknown/stale-profile
// cases explicitly; a stale remembered profile that no longer exists must
// not break the app."
import { describe, expect, it } from "vitest";
import { resolveActiveProfile } from "@/lib/profile/resolve";
import type { Profile } from "@/lib/profile/types";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: "🙂", colour: "#00ff00" };
const people: readonly Profile[] = [userA, userB];

describe("resolveActiveProfile", () => {
  it("returns null when nothing is stored — the no-profile-chosen-yet case", () => {
    expect(resolveActiveProfile(null, people)).toBeNull();
  });

  it("resolves the matching profile by id", () => {
    expect(resolveActiveProfile("user-a", people)).toEqual(userA);
  });

  it("resolves the SECOND profile correctly, not just whichever is first", () => {
    // Distinguishes a real find-by-id from a mutant that always returns
    // people[0] regardless of storedId.
    expect(resolveActiveProfile("user-b", people)).toEqual(userB);
  });

  it("returns null for a stale id that matches no known profile — must not throw", () => {
    expect(() => resolveActiveProfile("user-deleted", people)).not.toThrow();
    expect(resolveActiveProfile("user-deleted", people)).toBeNull();
  });

  it("returns null for a stale id against an empty profile list", () => {
    expect(resolveActiveProfile("user-a", [])).toBeNull();
  });

  it("is exact-match, not a prefix or substring match", () => {
    // A mutant loosening `===` to `.includes()` or similar would pass this
    // otherwise-similar id.
    expect(resolveActiveProfile("user-a-extra", people)).toBeNull();
    expect(resolveActiveProfile("user-", people)).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(resolveActiveProfile("USER-A", people)).toBeNull();
  });
});
