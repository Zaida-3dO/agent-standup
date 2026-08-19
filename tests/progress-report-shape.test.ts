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
  MAX_FLAGS_PER_REPORT,
  WAITING_STATES,
  applyFlagBudget,
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
    reference: { prUrl: null, branch: "feat/foundation", itemId: "item-a" },
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
      [row({ reference: { prUrl: null, branch: null, itemId: "item-z" } })],
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

  it("links the reference to the PR when the row has one", () => {
    // The half of the reference that makes a row ACTIONABLE: "in review,
    // branch feat/x" still leaves a reader to go and find the PR. Fails if
    // the link is dropped and a row with a recorded PR renders a bare span.
    const report = renderProgressReport(
      [
        row({
          reference: {
            prUrl: "https://example.com/org/repo/pull/7",
            branch: "feat/x",
            itemId: "item-a",
          },
        }),
      ],
      "s",
    );
    expect(report).toContain("[`feat/x`](https://example.com/org/repo/pull/7)");
  });

  it("uses the branch as the link text, not the URL", () => {
    // The branch is what a reader recognises; the URL is what they click.
    // Fails if the label and the target are swapped — which renders a
    // correct link that is unreadable in a list of ten.
    const report = renderProgressReport(
      [
        row({
          reference: {
            prUrl: "https://example.com/org/repo/pull/7",
            branch: "feat/x",
            itemId: "item-a",
          },
        }),
      ],
      "s",
    );
    expect(report).not.toContain("[https://example.com/org/repo/pull/7]");
  });

  it("renders a plain reference, not a link, when there is no PR", () => {
    // The fallback that keeps the promise: no recorded PR means no link at
    // all, rather than a link composed from the branch. Fails if the
    // renderer ever emits markdown link syntax for a null prUrl — which is
    // the exact shape a dead link would take.
    const report = renderProgressReport(
      [row({ reference: { prUrl: null, branch: "feat/x", itemId: "item-a" } })],
      "s",
    );
    expect(report).toContain("`feat/x`");
    expect(report).not.toContain("](");
  });

  it("links a branchless row on its item id", () => {
    // A PR can exist on an item whose branch was never recorded. Fails if
    // the link is made conditional on the branch rather than on the PR.
    const report = renderProgressReport(
      [row({ reference: { prUrl: "https://example.com/p/1", branch: null, itemId: "item-z" } })],
      "s",
    );
    expect(report).toContain("[`item-z`](https://example.com/p/1)");
  });

  it("says how many flags it withheld, rather than dropping them silently", () => {
    // A silently-dropped flag is the one failure worse than too many: the
    // report is trusted without audit, and a flag is the highest-stakes
    // thing in it. Fails if the footer is removed or the count is wrong.
    const report = renderProgressReport([row()], "s", 2);
    expect(report).toContain("2 further flags withheld");
    expect(report).toContain("open_loops");
  });

  it("says flag, singular, when it withheld exactly one", () => {
    expect(renderProgressReport([row()], "s", 1)).toContain("1 further flag withheld");
  });

  it("says nothing about withholding when it withheld nothing", () => {
    // Fails if the footer renders unconditionally — every report would carry
    // a "0 further flags withheld" line, which is noise on the common case.
    expect(renderProgressReport([row()], "s", 0)).not.toContain("withheld");
  });
});

describe("applyFlagBudget", () => {
  const flagged = (n: number, flags: string[]): ProgressRow => row({ n, flags });

  it("spends the budget across rows, not per row", () => {
    // The point of a REPORT-level cap: two rows carrying two flags each is
    // four flags, and a per-row cap alone would keep all four. Fails if the
    // budget is applied independently to each row — which is the mutation
    // that makes "sparingly" aspirational again.
    const result = applyFlagBudget([flagged(1, ["a", "b"]), flagged(2, ["c", "d"])]);
    const kept = result.rows.flatMap((r) => r.flags);
    expect(kept).toEqual(["a", "b", "c"]);
    expect(result.withheld).toBe(1);
  });

  it("serves rows in order, so the earliest-claimed work keeps its flags", () => {
    // Row order is claim order, and taking flags in a stated order is a rule
    // a reader can learn. Fails if the budget is spent by any other
    // ordering — the surviving flags would be unpredictable.
    const result = applyFlagBudget([
      flagged(1, ["first"]),
      flagged(2, ["second", "third", "fourth"]),
    ]);
    expect(result.rows[0]?.flags).toEqual(["first"]);
    expect(result.rows[1]?.flags).toEqual(["second", "third"]);
    expect(result.withheld).toBe(1);
  });

  it("lets a row with no flags cost nothing", () => {
    // Fails if the budget is decremented per row rather than per flag — an
    // unflagged row would eat a later row's entitlement.
    const result = applyFlagBudget([flagged(1, []), flagged(2, ["a", "b", "c"])]);
    expect(result.rows[1]?.flags).toEqual(["a", "b", "c"]);
    expect(result.withheld).toBe(0);
  });

  it("withholds nothing when the report is within budget", () => {
    const result = applyFlagBudget([flagged(1, ["a"]), flagged(2, ["b"])]);
    expect(result.withheld).toBe(0);
    expect(result.rows.flatMap((r) => r.flags)).toEqual(["a", "b"]);
  });

  it("counts every withheld flag, however many rows they came from", () => {
    // Fails if `withheld` stops accumulating across rows and reports only
    // the last row's overflow — the footer would understate the truncation.
    const result = applyFlagBudget([flagged(1, ["a", "b", "c", "d"]), flagged(2, ["e", "f"])]);
    expect(result.rows.flatMap((r) => r.flags)).toEqual(["a", "b", "c"]);
    expect(result.withheld).toBe(3);
  });

  it("keeps the report budget at the value the format is designed around", () => {
    // The counts above are LITERALS, not derived from the constant — a
    // derived expectation moves with the cap, so raising it to 99 would
    // still pass, which is precisely the mutation these tests exist to
    // catch. This line is what makes a deliberate change fail loudly in one
    // obvious place instead of looking like an unrelated breakage.
    expect(MAX_FLAGS_PER_REPORT).toBe(3);
  });

  it("returns the very same row object when a row is untouched", () => {
    // Not cosmetic: the budget is applied to every report, and rebuilding
    // every row would make identity useless to any caller memoising on it.
    // Fails if the function starts copying unconditionally.
    const untouched = flagged(1, ["a"]);
    expect(applyFlagBudget([untouched]).rows[0]).toBe(untouched);
  });
});

describe("renderProgressReport, the invariants of the whole report", () => {
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
