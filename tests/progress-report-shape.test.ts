// The progress report's shape — MILESTONES.md #136.
//
// The row's whole complaint is **inconsistency**, so the assertions here are
// about the shape holding still, not about any one report reading well. That
// makes the interesting cases the boring ones: an empty report, a report with
// one row, a report whose row has nothing to say. Each is a case a session
// composing prose by hand would have rendered differently every time, and
// each has a single right answer here.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import {
  DONE_STATES,
  WAITING_STATES,
  renderProgressReport,
  summarise,
  type ProgressRow,
} from "@/lib/progress-report";

/** A row with everything filled in, which each case then varies one part of. */
function row(overrides: Partial<ProgressRow> = {}): ProgressRow {
  return {
    n: 1,
    itemId: "item-a",
    title: "Building the app foundation",
    state: "in_review",
    reference: { branch: "feat/foundation", itemId: "item-a" },
    blockedOn: null,
    bullets: ["The foundation is built and every fixture is in place."],
    flags: [],
    ...overrides,
  };
}

describe("summarise", () => {
  it("says so plainly when the session holds nothing", () => {
    // A session holding nothing is a real answer, and the one most likely to
    // be rendered as an awkward empty list by a caller composing its own.
    expect(summarise([])).toBe("Nothing claimed by this session.");
  });

  it("counts in flight, waiting and done separately", () => {
    const summary = summarise([
      row({ state: "executing" }),
      row({ state: "blocked" }),
      row({ state: "merged" }),
    ]);
    expect(summary).toContain("3 items");
    expect(summary).toContain("1 in flight");
    expect(summary).toContain("1 waiting");
    expect(summary).toContain("1 done");
  });

  it("omits a bucket that is empty rather than printing a zero", () => {
    // "2 in flight" reads; "2 in flight, 0 waiting, 0 done" is noise on the
    // one line that has to be scannable. Fails if the parts stop being
    // filtered.
    const summary = summarise([row({ state: "executing" }), row({ state: "executing" })]);
    expect(summary).toContain("2 in flight");
    expect(summary).not.toContain("0 waiting");
    expect(summary).not.toContain("0 done");
  });

  it("says item, not items, for a single row", () => {
    expect(summarise([row()])).toContain("1 item:");
  });

  it("treats every terminal state as done", () => {
    // The states are **literals**, not a loop over `DONE_STATES`. Iterating
    // the set under test makes the assertion shrink with it: narrowing the
    // set to `merged` alone would still pass, because the loop would simply
    // stop checking the states that were removed. Proved by mutating the
    // source — the derived version survived that mutant, this does not.
    //
    // It matters because a cancelled item counted as in flight overstates
    // the work in progress, in exactly the report meant to be trusted on it.
    for (const state of ["merged", "research_done", "wont_do", "cancelled"]) {
      expect(summarise([row({ state })]), state).toContain("1 done");
    }
    // And the set itself carries no more than those four, so a state added
    // to it without thought fails here rather than silently vanishing from
    // the in-flight count.
    expect([...DONE_STATES].sort()).toEqual(["cancelled", "merged", "research_done", "wont_do"]);
  });

  it("treats blocked and paused as waiting", () => {
    // Literals, for the reason spelled out above.
    for (const state of ["blocked", "paused"]) {
      expect(summarise([row({ state })]), state).toContain("1 waiting");
    }
    expect([...WAITING_STATES].sort()).toEqual(["blocked", "paused"]);
  });
});

describe("renderProgressReport", () => {
  it("puts the summary first, so the answer precedes the detail", () => {
    const report = renderProgressReport([row()], "1 item: 1 in flight.");
    expect(report.split("\n")[0]).toBe("1 item: 1 in flight.");
  });

  it("numbers each row and carries its reference, title and state on one line", () => {
    const report = renderProgressReport([row()], "s");
    expect(report).toContain("1. `feat/foundation` Building the app foundation - in_review");
  });

  it("falls back to the item id when there is no branch", () => {
    // The reference is the one part of a row a reader acts on, so it is never
    // blank. Fails if the fallback is dropped and a branchless row renders an
    // empty reference.
    const report = renderProgressReport(
      [row({ reference: { branch: null, itemId: "item-z" } })],
      "s",
    );
    expect(report).toContain("`item-z`");
  });

  it("states the blocker on the row's own line when there is one", () => {
    const report = renderProgressReport([row({ blockedOn: "a decision from the owner" })], "s");
    expect(report).toContain("- Blocked on a decision from the owner");
  });

  it("says nothing about blocking when nothing is blocking", () => {
    // Fails if the blocker is rendered unconditionally — every unblocked row
    // would carry a dangling "Blocked on", which is worse than silence
    // because it reads as a blocker with a missing reason.
    expect(renderProgressReport([row({ blockedOn: null })], "s")).not.toContain("Blocked on");
  });

  it("renders bullets under their row and flags under the bullets", () => {
    // The indent is the whole distinction between a bullet and a flag, and
    // it is what "use sparingly" is expressed as visually.
    const report = renderProgressReport(
      [row({ bullets: ["Built and reviewed."], flags: ["Option B is still viable."] })],
      "s",
    );
    expect(report).toContain("\n- Built and reviewed.");
    expect(report).toContain("\n  - Option B is still viable.");
  });

  it("renders an empty report as just its summary", () => {
    expect(renderProgressReport([], "Nothing claimed by this session.")).toBe(
      "Nothing claimed by this session.",
    );
  });

  it("keeps the same shape whichever rows it is given", () => {
    // The row's actual requirement, asserted directly: two different reports
    // differ in content and not in structure. Fails if any row-level
    // formatting becomes conditional on something other than presence.
    const shapeOf = (report: string): string =>
      report
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          if (/^\d+\. /.test(line)) return "ROW";
          if (line.startsWith("  - ")) return "FLAG";
          if (line.startsWith("- ")) return "BULLET";
          return "SUMMARY";
        })
        .join("|");

    const first = renderProgressReport(
      [row({ n: 1, bullets: ["One."], flags: ["Flagged."] })],
      "summary",
    );
    const second = renderProgressReport(
      [
        row({
          n: 1,
          title: "Something else entirely",
          state: "executing",
          blockedOn: "review",
          bullets: ["Different."],
          flags: ["Also flagged."],
        }),
      ],
      "different summary",
    );
    expect(shapeOf(first)).toBe(shapeOf(second));
    expect(shapeOf(first)).toBe("SUMMARY|ROW|BULLET|FLAG");
  });
});
