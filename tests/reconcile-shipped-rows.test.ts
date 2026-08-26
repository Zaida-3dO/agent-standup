// Covers the one signal `scripts/reconcile-shipped-rows.mjs` trusts: a
// merged pull request whose title or body mentions a non-terminal row's own
// id, verbatim, as a UUID (row `17e83ab8-4d4f-4d2b-a00d-92651228112b`).
//
// The report this backs is deliberately conservative — it must never
// fabricate a candidate, and it must be honest that a row with no candidate
// here has NOT been confirmed unshipped. Both properties are asserted
// directly below, because a reconciliation report that occasionally invents
// evidence is worse than the stale-row problem it exists to catch.
import { describe, expect, it } from "vitest";
import {
  findShippedCandidates,
  pullRequestsReferencing,
  uuidsMentionedIn,
} from "@/lib/reconcile/shipped-rows";
import { renderReport } from "@/lib/reconcile/render-report";
import type { MergedPullRequest, ReconcilableItem } from "@/lib/reconcile/types";

const ITEM_A: ReconcilableItem = {
  id: "17e83ab8-4d4f-4d2b-a00d-92651228112b",
  title: "Nothing walks a shipped row forward",
  state: "on_deck",
  headline: "Reconciliation has no signal to walk a shipped row forward",
};

const ITEM_B: ReconcilableItem = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  title: "Some unrelated row with no PR at all",
  state: "plan_review",
  headline: null,
};

function pr(overrides: Partial<MergedPullRequest>): MergedPullRequest {
  return {
    number: 1,
    title: "",
    body: null,
    url: "https://github.com/example/repo/pull/1",
    mergedAt: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

describe("uuidsMentionedIn", () => {
  it("finds a UUID embedded in prose", () => {
    const found = uuidsMentionedIn(
      "Row 1 — 17e83ab8-4d4f-4d2b-a00d-92651228112b: archive form collision",
    );
    expect(found.has("17e83ab8-4d4f-4d2b-a00d-92651228112b")).toBe(true);
  });

  it("is case-insensitive, because gh and hand-typed prose disagree on casing", () => {
    const found = uuidsMentionedIn("17E83AB8-4D4F-4D2B-A00D-92651228112B");
    expect(found.has("17e83ab8-4d4f-4d2b-a00d-92651228112b")).toBe(true);
  });

  it("returns an empty set for null/undefined/empty text, never throwing", () => {
    // `gh` reports `body: null` for a PR with no description — this is the
    // exact shape that would crash a naive `.match()` call.
    expect(uuidsMentionedIn(null).size).toBe(0);
    expect(uuidsMentionedIn(undefined).size).toBe(0);
    expect(uuidsMentionedIn("").size).toBe(0);
  });

  it("does not match a near-UUID missing a character, and does not match a bare word", () => {
    // Single-character mutant coverage: change the `{4}` on the second group
    // to `{3}` and this would start matching `17e83ab8-4d4-4d2b-a00d-...`
    // (13 hex chars where a real UUID needs exactly 8-4-4-4-12), which is
    // precisely the over-matching this regex must not do.
    expect(uuidsMentionedIn("17e83ab8-4d4-4d2b-a00d-92651228112b").size).toBe(0);
    expect(uuidsMentionedIn("not a uuid at all").size).toBe(0);
  });
});

describe("pullRequestsReferencing", () => {
  it("matches a PR whose BODY names the row id", () => {
    const merged = [pr({ number: 10, body: `Row — ${ITEM_A.id}: fixed the thing` })];
    expect(pullRequestsReferencing(ITEM_A.id, merged)).toEqual(merged);
  });

  it("matches a PR whose TITLE names the row id, even with an empty body", () => {
    // The reason both fields are checked: a short PR whose only mention is
    // in the title would be silently missed if only body were read.
    const merged = [pr({ number: 11, title: `fix: ${ITEM_A.id}`, body: null })];
    expect(pullRequestsReferencing(ITEM_A.id, merged)).toEqual(merged);
  });

  it("does NOT match a PR that never mentions the id — no fuzzy title/branch fallback", () => {
    // This is the specific gap the report is required to name honestly: two
    // of the four rows that motivated this tool shipped inside a PR titled
    // for other work entirely. A weaker signal here would silently start
    // fabricating candidates instead of admitting the gap.
    const merged = [
      pr({ number: 12, title: "Three built-but-unreachable capabilities, made reachable" }),
    ];
    expect(pullRequestsReferencing(ITEM_A.id, merged)).toEqual([]);
  });

  it("does not cross-match a different row's id", () => {
    const merged = [pr({ number: 13, body: `Row — ${ITEM_B.id}` })];
    expect(pullRequestsReferencing(ITEM_A.id, merged)).toEqual([]);
  });
});

describe("findShippedCandidates", () => {
  it("produces one candidate per item that has at least one referencing PR", () => {
    const merged = [pr({ number: 20, body: ITEM_A.id })];
    const result = findShippedCandidates({ items: [ITEM_A, ITEM_B], mergedPullRequests: merged });
    expect(result).toHaveLength(1);
    expect(result[0]!.item.id).toBe(ITEM_A.id);
    expect(result[0]!.confidence).toBe("high");
    expect(result[0]!.evidence).toEqual(merged);
  });

  it("produces NO candidate for an item no PR mentions — absence is not asserted as unshipped", () => {
    const result = findShippedCandidates({ items: [ITEM_B], mergedPullRequests: [] });
    expect(result).toEqual([]);
  });

  it("sorts one item's multiple referencing PRs newest-merged-first", () => {
    const older = pr({ number: 30, body: ITEM_A.id, mergedAt: "2026-08-01T00:00:00Z" });
    const newer = pr({ number: 31, body: ITEM_A.id, mergedAt: "2026-08-20T00:00:00Z" });
    const result = findShippedCandidates({
      items: [ITEM_A],
      mergedPullRequests: [older, newer],
    });
    expect(result[0]!.evidence.map((p) => p.number)).toEqual([31, 30]);
  });

  it("treats a null mergedAt as oldest, rather than crashing the sort", () => {
    const noDate = pr({ number: 40, body: ITEM_A.id, mergedAt: null });
    const dated = pr({ number: 41, body: ITEM_A.id, mergedAt: "2026-08-20T00:00:00Z" });
    const result = findShippedCandidates({
      items: [ITEM_A],
      mergedPullRequests: [noDate, dated],
    });
    expect(result[0]!.evidence.map((p) => p.number)).toEqual([41, 40]);
  });

  it("never produces a candidate when there are zero merged PRs to search", () => {
    // The degraded-gh path: scripts/reconcile-shipped-rows.mjs passes an
    // empty array when `gh` is unavailable. This must reduce the candidate
    // list, never fabricate one from nothing.
    const result = findShippedCandidates({ items: [ITEM_A, ITEM_B], mergedPullRequests: [] });
    expect(result).toEqual([]);
  });
});

describe("renderReport", () => {
  it("names the row, its evidence link, and never claims to close anything", () => {
    const merged = [pr({ number: 50, title: "fix: thing", body: ITEM_A.id })];
    const candidates = findShippedCandidates({ items: [ITEM_A], mergedPullRequests: merged });
    const report = renderReport(candidates, { itemsChecked: 1, pullRequestsSearched: 1 });

    expect(report).toContain(ITEM_A.id);
    expect(report).toContain(ITEM_A.title);
    expect(report).toContain("#50");
    expect(report).toContain("does not close anything");
  });

  it("says plainly when zero candidates were found, rather than an empty section", () => {
    const report = renderReport([], { itemsChecked: 5, pullRequestsSearched: 12 });
    expect(report).toContain("No candidates found");
    expect(report).toContain("5");
    expect(report).toContain("12");
  });

  it("prints the item's headline, never `priority: undefined` — the slim shape has no priority field", () => {
    const merged = [pr({ number: 60, body: ITEM_A.id })];
    const candidates = findShippedCandidates({ items: [ITEM_A], mergedPullRequests: merged });
    const report = renderReport(candidates, { itemsChecked: 1, pullRequestsSearched: 1 });

    expect(report).toContain(`headline: ${ITEM_A.headline}`);
    expect(report).not.toContain("undefined");
  });

  it("omits the headline clause entirely when a row has none, rather than printing 'headline: null'", () => {
    const merged = [pr({ number: 61, body: ITEM_B.id })];
    const candidates = findShippedCandidates({ items: [ITEM_B], mergedPullRequests: merged });
    const report = renderReport(candidates, { itemsChecked: 1, pullRequestsSearched: 1 });

    expect(report).not.toContain("headline:");
    expect(report).not.toContain("null");
  });

  it("always states the deliverable-existence gap, regardless of candidate count", () => {
    // The report must not let a reader assume "no candidate" means "checked
    // and confirmed unshipped" — this is the sentence that says otherwise.
    const withCandidates = renderReport(
      findShippedCandidates({
        items: [ITEM_A],
        mergedPullRequests: [pr({ body: ITEM_A.id })],
      }),
      { itemsChecked: 1, pullRequestsSearched: 1 },
    );
    const withNone = renderReport([], { itemsChecked: 1, pullRequestsSearched: 0 });
    expect(withCandidates).toContain("not confirmed unshipped");
    expect(withNone).toContain("not confirmed unshipped");
  });
});
