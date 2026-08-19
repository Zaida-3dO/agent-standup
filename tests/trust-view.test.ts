// `trust-view.ts`'s pure helpers — MILESTONES.md #131. The SQL constant
// itself is exercised through `get-board.test.ts`'s DB-backed suite; this
// file is the mapping/grouping logic that needs no database.
import { describe, expect, it } from "vitest";
import {
  groupVerificationsByItem,
  isUnverifiedOrigin,
  toItemVerification,
  type RawVerificationRow,
} from "@/lib/service/items/trust-view";

describe("isUnverifiedOrigin", () => {
  // Fails if the string comparison is loosened (e.g. to a truthy check).
  it("is true only for a 'source' origin", () => {
    expect(isUnverifiedOrigin("source")).toBe(true);
  });

  // Fails if `person`/`auto` are folded into the same answer as `source`.
  it("is false for person and auto", () => {
    expect(isUnverifiedOrigin("person")).toBe(false);
    expect(isUnverifiedOrigin("auto")).toBe(false);
  });
});

function row(overrides: Partial<RawVerificationRow> = {}): RawVerificationRow {
  return {
    itemId: "item-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdByType: "agent",
    createdById: "crew-1",
    body: "Checked against the tip commit.",
    commitSha: "abc123",
    ...overrides,
  };
}

describe("toItemVerification", () => {
  // Fails if any field is dropped or mis-mapped, e.g. commitSha <-> body swapped.
  it("maps every field straight through", () => {
    const mapped = toItemVerification(row());
    expect(mapped).toEqual({
      checkedAt: "2026-01-01T00:00:00.000Z",
      checkedByType: "agent",
      checkedById: "crew-1",
      body: "Checked against the tip commit.",
      commitSha: "abc123",
    });
  });

  // Fails if `isoOrString` stops handling a `Date` input, e.g. returns it unconverted.
  it("stringifies a Date createdAt", () => {
    const mapped = toItemVerification(row({ createdAt: new Date("2026-02-02T10:00:00.000Z") }));
    expect(mapped.checkedAt).toBe("2026-02-02T10:00:00.000Z");
  });
});

describe("groupVerificationsByItem", () => {
  // Fails if the grouping keys on the wrong field, e.g. groups by createdById.
  it("buckets rows by itemId", () => {
    const byItem = groupVerificationsByItem([
      row({ itemId: "a", commitSha: "sha-a" }),
      row({ itemId: "b", commitSha: "sha-b" }),
    ]);
    expect(byItem.get("a")?.commitSha).toBe("sha-a");
    expect(byItem.get("b")?.commitSha).toBe("sha-b");
  });

  // Fails if an item with no verification row silently gets a default entry
  // instead of being absent from the map — "nobody has checked" and "we did
  // not look" must not render identically (#123's rule, applied here).
  it("has no entry for an item with no verification row", () => {
    const byItem = groupVerificationsByItem([row({ itemId: "a" })]);
    expect(byItem.has("b")).toBe(false);
    expect(byItem.get("b")).toBeUndefined();
  });

  it("returns an empty map for no rows", () => {
    expect(groupVerificationsByItem([]).size).toBe(0);
  });
});
