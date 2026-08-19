// The Plan tab's arrangement — which snapshot is live, which are
// superseded, and what the tab leads with.
//
// Plain functions over plain data, run with no DOM and no database.
import { describe, expect, it } from "vitest";
import { planBluf, planTimeline } from "@/lib/item-detail/plan";
import type { DetailArtifact } from "@/lib/item-detail/types";

function artifact(overrides: Partial<DetailArtifact> = {}): DetailArtifact {
  return {
    id: "art-1",
    kind: "plan",
    verdict: null,
    reviewRound: 1,
    commitSha: null,
    ref: null,
    body: null,
    findings: null,
    followUpItemId: null,
    createdByType: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the plan timeline", () => {
  it("takes the LAST plan in server order as the live one", () => {
    // The server orders by round then creation time, and this reads
    // position rather than re-sorting — so the ordering rule lives in one
    // place. Taking `snapshots[0]` instead would surface the oldest plan as
    // current, which is precisely the defect: the reader lands on a plan
    // replaced twice since.
    const { latest } = planTimeline([
      artifact({ id: "p1", reviewRound: 1 }),
      artifact({ id: "p2", reviewRound: 2 }),
      artifact({ id: "p3", reviewRound: 3 }),
    ]);
    expect(latest?.id).toBe("p3");
  });

  it("takes the later of two plans sharing a round", () => {
    // A plan revised twice before any review looked at either. Round alone
    // cannot separate them; position can, and the later-written one is the
    // current one by every reading.
    const { latest, superseded } = planTimeline([
      artifact({ id: "early", reviewRound: 2, createdAt: "2026-01-01T09:00:00.000Z" }),
      artifact({ id: "late", reviewRound: 2, createdAt: "2026-01-01T17:00:00.000Z" }),
    ]);
    expect(latest?.id).toBe("late");
    expect(superseded.map((s) => s.id)).toEqual(["early"]);
  });

  it("lists superseded snapshots most recent first", () => {
    // Someone reaching into history almost always wants the version
    // immediately before the current one. Dropping the `.reverse()` puts the
    // oldest at the top and buries it.
    const { superseded } = planTimeline([
      artifact({ id: "p1", reviewRound: 1 }),
      artifact({ id: "p2", reviewRound: 2 }),
      artifact({ id: "p3", reviewRound: 3 }),
    ]);
    expect(superseded.map((s) => s.id)).toEqual(["p2", "p1"]);
  });

  it("puts every plan in exactly one of latest and superseded", () => {
    // Disjoint and complete. Rendering a snapshot in both places would let a
    // reader see the same plan twice with no way to tell whether it was one
    // row or two.
    const plans = [artifact({ id: "p1", reviewRound: 1 }), artifact({ id: "p2", reviewRound: 2 })];
    const { latest, superseded } = planTimeline(plans);
    const seen = [latest?.id, ...superseded.map((s) => s.id)];
    expect(new Set(seen).size).toBe(plans.length);
  });

  it("separates plan reviews from the plans themselves", () => {
    // A review's verdict is a different kind of claim from a plan's body,
    // and interleaving them was half of why the column read as
    // undifferentiated.
    const { latest, superseded, reviews } = planTimeline([
      artifact({ id: "p1", kind: "plan" }),
      artifact({ id: "r1", kind: "plan_review", verdict: "changes_required" }),
    ]);
    expect(latest?.id).toBe("p1");
    expect(superseded).toHaveLength(0);
    expect(reviews.map((r) => r.id)).toEqual(["r1"]);
  });

  it("has no live plan when only reviews exist", () => {
    const { latest, reviews } = planTimeline([artifact({ id: "r1", kind: "plan_review" })]);
    expect(latest).toBeNull();
    expect(reviews).toHaveLength(1);
  });

  it("is empty on no artifacts at all", () => {
    const { latest, superseded, reviews } = planTimeline([]);
    expect(latest).toBeNull();
    expect(superseded).toEqual([]);
    expect(reviews).toEqual([]);
  });
});

describe("the plan BLUF", () => {
  it("takes the first paragraph of prose", () => {
    expect(planBluf("The work is to bound the reads.\n\nThen the rest follows.")).toBe(
      "The work is to bound the reads.",
    );
  });

  it("joins a wrapped paragraph into one line", () => {
    expect(planBluf("The work is to\nbound the reads.\n\nMore.")).toBe(
      "The work is to bound the reads.",
    );
  });

  it("skips a leading heading rather than summarising it", () => {
    // A plan opening with `# Plan` would otherwise have "Plan" as its entire
    // summary — a lead line that says nothing, in the most prominent
    // position on the tab. Removing the heading skip fails this.
    expect(planBluf("# Plan\n\nBound every read to a page.")).toBe("Bound every read to a page.");
  });

  it("skips a leading code fence", () => {
    // A plan opening with a command is describing a shape, not stating its
    // bottom line.
    expect(planBluf("```bash\nnpm run build\n```\n\nShip the build step.")).toBe(
      "Ship the build step.",
    );
  });

  it("skips a horizontal rule", () => {
    expect(planBluf("---\n\nThe actual line.")).toBe("The actual line.");
  });

  it("falls back to the first list item when there is no prose", () => {
    // A plan written as nothing but a bulleted list is a real shape, and
    // returning null for it would leave the tab's most prominent line empty
    // on a plan that is perfectly readable.
    expect(planBluf("# Steps\n\n- Bound the reads\n- Then the writes")).toBe("Bound the reads");
  });

  it("prefers prose over a list when both are present", () => {
    expect(planBluf("Bound the reads first.\n\n- step one\n- step two")).toBe(
      "Bound the reads first.",
    );
  });

  it("strips inline markdown marks", () => {
    // This renders as plain text in a lead position, where a stray asterisk
    // pair reads as a typo rather than as bold.
    expect(planBluf("Bound **every** read to a `page`, see [the doc](http://x/y).")).toBe(
      "Bound every read to a page, see the doc.",
    );
  });

  it("reads a blockquote as prose", () => {
    expect(planBluf("> The bottom line, quoted.")).toBe("The bottom line, quoted.");
  });

  it("has nothing to say for an empty or whitespace-only body", () => {
    // Omitted rather than rendered empty — an empty lead block reads as a
    // rendering fault, where its absence reads as nothing to say.
    expect(planBluf(null)).toBeNull();
    expect(planBluf("")).toBeNull();
    expect(planBluf("   \n\n  ")).toBeNull();
    expect(planBluf("## Only a heading")).toBeNull();
  });

  it("bounds a long paragraph and says so with an ellipsis", () => {
    // The BLUF's whole job is to be shorter than the thing it summarises, so
    // it must have a ceiling. Raising `BLUF_MAX_CHARS` past the length below
    // fails this.
    const long = `${"word ".repeat(400)}end`;
    const bluf = planBluf(long);
    expect(bluf).not.toBeNull();
    expect(bluf!.length).toBeLessThanOrEqual(321);
    expect(bluf!.endsWith("…")).toBe(true);
  });

  it("cuts on a word boundary rather than mid-word", () => {
    const long = `${"alpha ".repeat(200)}omega`;
    const bluf = planBluf(long)!;
    // The character before the ellipsis is the end of a whole word, never a
    // fragment of one — a mid-word cut reads as a rendering fault.
    expect(bluf.slice(0, -1).trimEnd().endsWith("alpha")).toBe(true);
  });

  it("does not scan an unbounded body looking for prose", () => {
    // The scan is capped, so a 200,000-character body of nothing but
    // headings costs a fixed amount rather than a linear one. Past the cap
    // there is nothing to find, which is reported as nothing.
    const body = `${"# heading\n\n".repeat(5000)}The real line.`;
    expect(planBluf(body)).toBeNull();
  });
});
