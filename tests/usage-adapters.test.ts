// The usage-adapter registry — SCHEMA.md §15, §17.7, §23.2. MILESTONES.md
// #92. Pure and DB-free: `isRegisteredVendor` is a closed-list membership
// check, so this is the module that has to prove an unregistered vendor is
// genuinely refused (`update-account.test.ts`/`admin-operations.test.ts`
// then prove the *operation* refuses on top of this).
import { describe, expect, it } from "vitest";
import {
  REGISTERED_VENDORS,
  isRegisteredVendor,
  type VendorName,
} from "@/lib/service/usage-adapters";

describe("REGISTERED_VENDORS", () => {
  it("is non-empty, so the membership check below is not vacuously false for everything", () => {
    expect(REGISTERED_VENDORS.length).toBeGreaterThan(0);
  });

  it("contains anthropic — the vendor the seed data (prisma/seed.mjs) uses", () => {
    expect(REGISTERED_VENDORS).toContain("anthropic");
  });
});

describe("isRegisteredVendor", () => {
  it("accepts every name in the registered list", () => {
    for (const vendor of REGISTERED_VENDORS) {
      expect(isRegisteredVendor(vendor)).toBe(true);
    }
  });

  it("rejects a vendor with no registered usage adapter", () => {
    expect(isRegisteredVendor("openai")).toBe(false);
    expect(isRegisteredVendor("not-a-real-vendor")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isRegisteredVendor("")).toBe(false);
  });

  it("is case-sensitive — 'Anthropic' is not the same key as 'anthropic'", () => {
    expect(isRegisteredVendor("Anthropic")).toBe(false);
    expect(isRegisteredVendor("ANTHROPIC")).toBe(false);
  });

  it("does not accidentally match a substring or prefix of a registered name", () => {
    expect(isRegisteredVendor("anthro")).toBe(false);
    expect(isRegisteredVendor("anthropic-2")).toBe(false);
  });

  it("narrows its argument's type on a true result", () => {
    const value: string = "anthropic";
    if (isRegisteredVendor(value)) {
      // Compiles only if the guard actually narrows `string` to `VendorName`.
      const narrowed: VendorName = value;
      expect(narrowed).toBe("anthropic");
    } else {
      throw new Error("expected isRegisteredVendor('anthropic') to be true");
    }
  });
});
