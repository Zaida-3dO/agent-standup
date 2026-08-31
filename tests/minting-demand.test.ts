// The minting trigger — MILESTONES.md #63's "triggered by demand".
//
// Pure functions over a count, a settings value and two lists, so no
// database is needed and none is gated on. Every test names the mutation it
// kills; the threshold ones sit exactly ON the boundary, because an
// off-by-one in a `<` is the entire failure mode available to this code and
// a test at `onDeck = 0, threshold = 3` cannot see it.
import { describe, expect, it } from "vitest";
import {
  assessMintDemand,
  backlogIsLow,
  effectiveSourceGlobs,
  pendingSources,
} from "@/lib/minting/demand";
import { formatSourceRef } from "@/lib/minting/source-ref";

describe("backlogIsLow (#63)", () => {
  // Kills: `<` → `<=`. This is the whole boundary, and only the exact-match
  // case can see it — §17.7 says "below this", so AT the threshold the
  // backlog is sufficient.
  it("is false at exactly the threshold and true one below it", () => {
    expect(backlogIsLow(3, 3)).toBe(false);
    expect(backlogIsLow(2, 3)).toBe(true);
  });

  // Kills: `<` → `>`, and any inversion of the comparison.
  it("is false above the threshold and true at an empty backlog", () => {
    expect(backlogIsLow(4, 3)).toBe(false);
    expect(backlogIsLow(0, 3)).toBe(true);
  });

  // Kills: a hardcoded threshold ignoring the setting. A threshold of 0
  // means "never scan on backlog", which must be expressible.
  it("never triggers when the threshold is zero", () => {
    expect(backlogIsLow(0, 0)).toBe(false);
  });
});

describe("assessMintDemand (#63)", () => {
  const base = { onDeck: 0, threshold: 3, sourceGlobs: ["notes/**/*.md"], scanInFlight: false };

  // Kills: never returning `scan: true`.
  it("scans when the backlog is low, sources exist and nothing is in flight", () => {
    expect(assessMintDemand(base)).toEqual({ scan: true, reason: "backlog-low", onDeck: 0 });
  });

  // Kills: dropping the backlog check and scanning unconditionally.
  it("does not scan when the backlog is already sufficient", () => {
    expect(assessMintDemand({ ...base, onDeck: 5 })).toEqual({
      scan: false,
      reason: "backlog-sufficient",
      onDeck: 5,
    });
  });

  // Kills: dropping the no-sources check — which on a fresh install (globs
  // default to `[]`) would scan nothing, repeatedly, and report it as work.
  it("does not scan when no globs are configured, even with an empty backlog", () => {
    expect(assessMintDemand({ ...base, sourceGlobs: [] })).toEqual({
      scan: false,
      reason: "no-sources",
    });
  });

  // Kills: dropping the lease check — §13's "an unclaimed mint dispatch
  // means don't issue another".
  it("does not scan while another scan is already in flight", () => {
    expect(assessMintDemand({ ...base, scanInFlight: true })).toEqual({
      scan: false,
      reason: "already-scanning",
    });
  });

  // Kills: reordering the guards so a missing-sources install reports
  // "already-scanning", or so an in-flight scan reports "backlog-low".
  // The reason is what an operator reads to know why nothing is happening,
  // so the precedence has to be pinned, not just the boolean.
  it("reports the most fundamental reason first when several apply", () => {
    expect(
      assessMintDemand({ ...base, sourceGlobs: [], scanInFlight: true, onDeck: 99 }),
    ).toEqual({ scan: false, reason: "no-sources" });
    expect(assessMintDemand({ ...base, scanInFlight: true, onDeck: 99 })).toEqual({
      scan: false,
      reason: "already-scanning",
    });
  });
});

describe("effectiveSourceGlobs (#63)", () => {
  const setting = ["default/**/*.md"];

  // Kills: ignoring the machine override entirely.
  it("prefers a machine's own globs over the setting", () => {
    expect(effectiveSourceGlobs(["machine/**/*.md"], setting)).toEqual(["machine/**/*.md"]);
  });

  // Kills: dropping the inherit path.
  it("inherits the setting when the machine carries none", () => {
    expect(effectiveSourceGlobs(null, setting)).toEqual(setting);
    expect(effectiveSourceGlobs(undefined, setting)).toEqual(setting);
  });

  // Kills: `machineGlobs ?? setting` or any truthiness check — both of
  // which turn "this machine scans nothing" into "this machine scans the
  // defaults", which is a machine scanning paths that may not exist on it.
  // This is the distinction the whole function exists for.
  it("treats an empty machine list as 'scans nothing', not as 'inherit'", () => {
    expect(effectiveSourceGlobs([], setting)).toEqual([]);
  });

  // Kills: merging the two lists instead of overriding.
  it("overrides rather than merges", () => {
    expect(effectiveSourceGlobs(["a"], ["b"])).toEqual(["a"]);
  });
});

describe("pendingSources (#63)", () => {
  const found = [
    { path: "a.md", contentHash: "1111111111111111" },
    { path: "b.md", contentHash: "2222222222222222" },
  ];

  // Kills: returning everything unfiltered.
  it("drops sources already minted at that exact version", () => {
    const minted = new Set([formatSourceRef("a.md", "1111111111111111")]);
    expect(pendingSources(found, minted)).toEqual([found[1]]);
  });

  // Kills: matching on path alone. An edited file must come back as
  // pending — §13's "editing a file changes its hash, so it becomes
  // eligible again". Matching on path would make an edit invisible forever.
  it("returns a file whose content has changed since it was minted", () => {
    const minted = new Set([formatSourceRef("a.md", "old-hash-aaaaaaaa")]);
    expect(pendingSources(found, minted)).toEqual(found);
  });

  // Kills: inverting the filter.
  it("returns nothing when everything is already minted", () => {
    const minted = new Set(found.map((s) => formatSourceRef(s.path, s.contentHash)));
    expect(pendingSources(found, minted)).toEqual([]);
  });
});
