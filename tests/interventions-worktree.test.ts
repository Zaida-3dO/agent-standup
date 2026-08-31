// Normalising worktree paths so two spellings of one directory compare
// equal — `src/lib/interventions/worktree.ts`, MILESTONES.md #128.
//
// I15 keyed on `(machine, repo)` alone because `Assignment.worktree` is free
// text a caller supplies, and raw equality over free text passes silently on
// exactly the collisions the entry exists to catch. That argument is against
// naive comparison rather than against comparison, and this file is what
// makes the non-naive version safe to rely on: every fold is pinned, and so
// is every fold deliberately not performed.
//
// Every path here is invented. This repository is public, and a real
// checkout path in a fixture names a machine and its owner.
import { describe, expect, it } from "vitest";
import { normaliseWorktree, sameWorktree } from "@/lib/interventions/worktree";

describe("normaliseWorktree", () => {
  it("treats a missing path as not comparable, never as empty", () => {
    // The distinction the whole design rests on. Answering `""` would make
    // two unknown paths compare equal, and `Assignment.worktree` is nullable
    // with `claim`'s `worktree` optional — so "unknown" is the common case,
    // and collapsing it would block every crew that omitted the field.
    expect(normaliseWorktree(null)).toBeUndefined();
    expect(normaliseWorktree(undefined)).toBeUndefined();
    expect(normaliseWorktree("")).toBeUndefined();
    expect(normaliseWorktree("   ")).toBeUndefined();
  });

  it("folds slash direction", () => {
    // A Windows caller may send either, and one tool prints both in
    // different contexts.
    expect(normaliseWorktree("C:\\checkouts\\wt-one")).toBe(
      normaliseWorktree("C:/checkouts/wt-one"),
    );
  });

  it("folds trailing and repeated separators", () => {
    expect(normaliseWorktree("/checkouts/wt-one/")).toBe(normaliseWorktree("/checkouts/wt-one"));
    expect(normaliseWorktree("/checkouts//wt-one")).toBe(normaliseWorktree("/checkouts/wt-one"));
  });

  it("resolves `.` and `..` segments", () => {
    expect(normaliseWorktree("/checkouts/./wt-one")).toBe(normaliseWorktree("/checkouts/wt-one"));
    expect(normaliseWorktree("/checkouts/wt-two/../wt-one")).toBe(
      normaliseWorktree("/checkouts/wt-one"),
    );
  });

  it("folds case on a Windows-shaped path", () => {
    // The filesystem behind a drive-letter or UNC path folds case here, so
    // two spellings denote one directory.
    expect(normaliseWorktree("C:/Checkouts/WT-One")).toBe(normaliseWorktree("c:/checkouts/wt-one"));
    expect(normaliseWorktree("//Server/Share/WT-One")).toBe(
      normaliseWorktree("//server/share/wt-one"),
    );
  });

  it("does NOT fold case on a POSIX path", () => {
    // The conditional half, and the one that would quietly reintroduce a
    // false positive if it were unconditional: POSIX filesystems
    // distinguish these, so folding them would call two different
    // directories one and block a crew against a crew somewhere else.
    expect(normaliseWorktree("/checkouts/WT-One")).not.toBe(normaliseWorktree("/checkouts/wt-one"));
  });

  it("keeps a UNC path's leading double separator", () => {
    // Those two are significant where every other repeat is noise.
    // Collapsing them turns a network path into a local absolute one.
    expect(normaliseWorktree("//server/share/wt-one")).toBe("//server/share/wt-one");
    expect(normaliseWorktree("//server/share/wt-one")).not.toBe(
      normaliseWorktree("/server/share/wt-one"),
    );
  });

  it("does not merge two hosts' paths", () => {
    expect(normaliseWorktree("//server-one/share/wt")).not.toBe(
      normaliseWorktree("//server-two/share/wt"),
    );
  });

  it("understands a local file URL", () => {
    expect(normaliseWorktree("file:///checkouts/wt-one")).toBe(
      normaliseWorktree("/checkouts/wt-one"),
    );
    expect(normaliseWorktree("file:///C:/checkouts/wt-one")).toBe(
      normaliseWorktree("C:/checkouts/wt-one"),
    );
    // Percent-encoding is URL syntax rather than part of the name.
    expect(normaliseWorktree("file:///checkouts/wt%20one")).toBe(
      normaliseWorktree("/checkouts/wt one"),
    );
  });

  it("keeps distinct directories distinct", () => {
    // The direction that matters most: over-folding is how a fix for a
    // false positive becomes a false negative on the incident the guard
    // exists to prevent.
    expect(normaliseWorktree("/checkouts/wt-one")).not.toBe(normaliseWorktree("/checkouts/wt-two"));
    // A prefix is not the same directory.
    expect(normaliseWorktree("/checkouts/wt")).not.toBe(normaliseWorktree("/checkouts/wt-one"));
    // Nor is a child.
    expect(normaliseWorktree("/checkouts/wt-one")).not.toBe(
      normaliseWorktree("/checkouts/wt-one/src"),
    );
  });

  it("does not equate a relative path with an absolute one", () => {
    // Without a base they are not comparable, and guessing a base is how a
    // comparison becomes confidently wrong.
    expect(normaliseWorktree("wt-one")).not.toBe(normaliseWorktree("/checkouts/wt-one"));
  });

  it("keeps a leading `..` on a relative path", () => {
    // Nothing to climb over, and dropping it would turn `../sibling` into
    // `sibling` — two directories silently made one.
    expect(normaliseWorktree("../wt-one")).not.toBe(normaliseWorktree("wt-one"));
  });

  it("treats a bare root as not comparable", () => {
    // Every path on a machine is "inside" the root, so admitting it as a
    // value would let one claim match everything.
    expect(normaliseWorktree("/")).toBeUndefined();
    expect(normaliseWorktree("//")).toBeUndefined();
    expect(normaliseWorktree(".")).toBeUndefined();
  });
});

describe("sameWorktree", () => {
  it("answers true for two spellings of one tree", () => {
    expect(sameWorktree("C:\\Checkouts\\WT-One\\", "c:/checkouts/./wt-one")).toBe(true);
  });

  it("answers false for sibling worktrees", () => {
    // The healthy arrangement every parallel dispatch here uses.
    expect(sameWorktree("/checkouts/wt-one", "/checkouts/wt-two")).toBe(false);
  });

  it("answers undefined when either side is unknown", () => {
    // Three-valued deliberately. The caller decides what to do with "cannot
    // tell", because the two collapses are wrong in opposite directions and
    // only the caller knows which risk it is taking.
    expect(sameWorktree(null, "/checkouts/wt-one")).toBeUndefined();
    expect(sameWorktree("/checkouts/wt-one", null)).toBeUndefined();
    expect(sameWorktree(null, null)).toBeUndefined();
    expect(sameWorktree("  ", "/checkouts/wt-one")).toBeUndefined();
  });
});
