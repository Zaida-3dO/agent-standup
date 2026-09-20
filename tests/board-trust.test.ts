// `@/lib/board/trust` — the shared "should this row carry a trust badge?"
// predicate the board surfaces ask, and the props derivation beside it.
//
// The whole point of this module is that ONE spelling exists, so these tests
// pin the predicate directly rather than only through the two components:
// a component test proves a call site is wired, and this proves the thing it
// is wired to is right.
import { describe, expect, it } from "vitest";
import { showsTrustBadge, trustPresentation } from "@/lib/board/trust";
import type { ItemVerification, TrustInfo } from "@/lib/board/types";

const CHECK: ItemVerification = {
  checkedAt: "2026-02-03T04:05:06.000Z",
  checkedByType: "person",
  checkedById: "ope",
  body: "Walked the row against the live system.",
  commitSha: "deadbee",
};

function trust(unverifiedOrigin: boolean, verification: ItemVerification | null): TrustInfo {
  return { unverifiedOrigin, verification };
}

describe("showsTrustBadge", () => {
  // The rows that have something to verify. Fails if the predicate is
  // inverted or starts reading `.verification`.
  it("is true for an imported row nobody has checked", () => {
    expect(showsTrustBadge(trust(true, null))).toBe(true);
  });

  // THE case a naive `if (!verified) return null` deletes. `unverifiedOrigin`
  // is permanent and does not clear when someone checks, so the badge stays
  // and keeps naming who looked. Fails the moment the gate reads the check
  // instead of the origin.
  it("is STILL true for an imported row that has since been verified", () => {
    expect(showsTrustBadge(trust(true, CHECK))).toBe(true);
  });

  // The defect this guards: a call site gating on `entry.trust` being
  // non-null marks every row, because every non-project row has one.
  it("is false for a natively-created row, which has nothing to verify", () => {
    expect(showsTrustBadge(trust(false, null))).toBe(false);
  });

  // A stray `historical_verification` against a native row must not promote
  // it into the marked set — the same reasoning `trustCondition`'s header
  // gives for `verified` being `imported AND checked` rather than `checked`.
  it("is false for a native row even with a verification on file", () => {
    expect(showsTrustBadge(trust(false, CHECK))).toBe(false);
  });

  // `null` is a project (no `state` of its own to distrust); `undefined` is
  // a caller with no trust information. Both mean "nothing to mark", and
  // neither may throw. Fails on `trust.unverifiedOrigin` without the `?.`.
  it("is false for a project and for a missing trust record", () => {
    expect(showsTrustBadge(null)).toBe(false);
    expect(showsTrustBadge(undefined)).toBe(false);
  });
});

describe("trustPresentation", () => {
  it("reports unverified, and names no checker, with no check on file", () => {
    expect(trustPresentation(trust(true, null))).toEqual({ verified: false });
  });

  // Criterion 3's substance: the provenance survives the derivation. Fails
  // if any of the three check fields stops being forwarded — which is how
  // `checkedById` was dropped on the floor once before (T25 #3).
  it("forwards who checked and when, so the badge can name them", () => {
    expect(trustPresentation(trust(true, CHECK))).toEqual({
      verified: true,
      checkedAt: "2026-02-03T04:05:06.000Z",
      checkedByType: "person",
      checkedById: "ope",
    });
  });
});
