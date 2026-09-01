// Folding an item's artifacts into the build status a reader sees.
//
// The boundaries this file exists to pin are the ones where a wrong answer is
// convincing: an item with no build reported at all, a build whose status
// cannot be read, and — the one with the most teeth — a **passing build
// against a commit the item has moved past**, which a caller would otherwise
// read as permission to merge work the build never saw.
//
// Pure module, no database: this file never skips. `foldBuildStatus` takes
// the tip and the lineage as arguments precisely so the fold is testable
// without one; the queries that produce them are exercised in the DB-backed
// detail test.
import { describe, expect, it } from "vitest";
import { foldBuildStatus, type CheckRunArtifactRow } from "@/lib/service/items/build-status";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const TIP = "a".repeat(40);

/** A `check_run` row with sensible defaults, so each test states only what it is about. */
function checkRun(overrides: Partial<CheckRunArtifactRow> = {}): CheckRunArtifactRow {
  return {
    kind: "check_run",
    body: "passing",
    ref: "https://build.example/runs/1",
    commitSha: TIP,
    reviewRound: 1,
    createdAt: new Date("2026-09-01T11:59:30.000Z"),
    ...overrides,
  };
}

describe("an item with no build reported", () => {
  it("folds to null rather than an empty status", () => {
    // The majority case on any real store. `null` says "no build was ever
    // reported", which is a different statement from "a build was reported
    // and nobody can read it" — and a caller must be able to tell them apart.
    // Fails if the fold ever returns a view with every field empty.
    expect(foldBuildStatus([], null, new Set(), NOW)).toBeNull();
  });

  it("ignores artifacts of every other kind", () => {
    // An item with a PR, a commit and two reviews has reported no build. If
    // the kind filter were dropped, one of these rows would be folded as a
    // build status and its prose body read as one — reported as unknown, on
    // an item that never mentioned a build.
    const others: CheckRunArtifactRow[] = [
      checkRun({ kind: "pull_request", body: "open" }),
      checkRun({ kind: "commit", body: null }),
      checkRun({ kind: "code_review", body: "looks good" }),
      checkRun({ kind: "test_run", body: "passing" }),
    ];
    expect(foldBuildStatus(others, TIP, new Set([TIP]), NOW)).toBeNull();
  });
});

describe("the newest reported status wins", () => {
  it("takes the last check_run in the ascending list", () => {
    // `get_item_detail` reads artifacts ascending, so the last matching row
    // is the newest. A build that went pending → failing → passing is three
    // rows, and the answer is the third.
    //
    // Fails if the fold ever takes the first match: the item would be
    // reported as `pending` forever, because artifacts are append-only and
    // the row that said so is never edited.
    const rows = [
      checkRun({ body: "pending", createdAt: new Date("2026-09-01T11:00:00.000Z") }),
      checkRun({ body: "failing", createdAt: new Date("2026-09-01T11:30:00.000Z") }),
      checkRun({ body: "passing", createdAt: new Date("2026-09-01T11:59:00.000Z") }),
    ];
    const folded = foldBuildStatus(rows, TIP, new Set([TIP]), NOW);
    expect(folded?.status).toBe("passing");
    expect(folded?.recordedAt).toBe("2026-09-01T11:59:00.000Z");
  });

  it("reads a newer failure over an older pass", () => {
    // The direction that matters for safety: a build that was green and has
    // since gone red must report red. Fails if ordering is reversed or if any
    // "prefer a passing row" preference is introduced.
    const rows = [
      checkRun({ body: "passing", createdAt: new Date("2026-09-01T11:00:00.000Z") }),
      checkRun({ body: "failing", createdAt: new Date("2026-09-01T11:50:00.000Z") }),
    ];
    expect(foldBuildStatus(rows, TIP, new Set([TIP]), NOW)?.status).toBe("failing");
  });
});

describe("staleness — how old the status is", () => {
  it("reports the age in seconds alongside the status", () => {
    // The headline staleness fact. A status with no age is a claim a reader
    // cannot weigh, which is the failure this whole field exists to prevent.
    const folded = foldBuildStatus([checkRun()], TIP, new Set([TIP]), NOW);
    expect(folded?.ageSeconds).toBe(30);
    expect(folded?.recordedAt).toBe("2026-09-01T11:59:30.000Z");
  });

  it("reports a day-old status as a day old, not as fresh", () => {
    // THE mutation target. If the age were computed from `now` against `now`,
    // or hard-coded, or dropped, a status recorded a day ago would present
    // exactly like one recorded a second ago — a stale status reported as
    // current, which is the named plausible mistake for this work.
    const stale = checkRun({ createdAt: new Date("2026-08-31T12:00:00.000Z") });
    const folded = foldBuildStatus([stale], TIP, new Set([TIP]), NOW);
    expect(folded?.status).toBe("passing");
    expect(folded?.ageSeconds).toBe(86_400);
    // Stated as an inequality too, so the claim survives a change to the
    // fixture's timestamps: whatever the numbers, a day-old status must not
    // report a small age.
    expect(folded!.ageSeconds).toBeGreaterThan(3600);
  });
});

describe("staleness — whether the build ran against the current tip", () => {
  it("reports a build at the tip as at the tip", () => {
    const folded = foldBuildStatus([checkRun()], TIP, new Set([TIP]), NOW);
    expect(folded?.atTip).toBe(true);
  });

  it("reports a passing build against a superseded commit as not at tip", () => {
    // The single most dangerous row in the store: green, recent, and about
    // code the item has moved past. The status is still reported — suppressing
    // it would lose a true fact — but `atTip: false` is what stops it being
    // read as permission to merge.
    //
    // Fails if `atTip` is dropped, hard-coded to `true`, or computed against
    // the status's own commit instead of the item's tip.
    const old = checkRun({ commitSha: "b".repeat(40) });
    const folded = foldBuildStatus([old], TIP, new Set([TIP]), NOW);
    expect(folded?.status).toBe("passing");
    expect(folded?.atTip).toBe(false);
  });

  it("accepts an abbreviated sha against a full-length tip", () => {
    // A build reported from `git log --oneline` output carries 7 characters.
    // Refusing it as stale would be a false alarm on the ordinary call, and
    // a staleness signal that cries wolf is one readers learn to skip.
    const folded = foldBuildStatus(
      [checkRun({ commitSha: TIP.slice(0, 7) })],
      TIP,
      new Set([TIP]),
      NOW,
    );
    expect(folded?.atTip).toBe(true);
  });

  it("accepts a build against a commit the tip superseded", () => {
    // A squash or a rebase mints a new sha for already-built work. The
    // lineage is what carries the build forward onto it — the same rule the
    // merge gate applies to an approval, applied here so the two cannot
    // disagree about what "at tip" means.
    const superseded = "c".repeat(40);
    const folded = foldBuildStatus(
      [checkRun({ commitSha: superseded })],
      TIP,
      new Set([TIP, superseded]),
      NOW,
    );
    expect(folded?.atTip).toBe(true);
  });

  it("reports at-tip as unknown when the build recorded no commit", () => {
    // `null`, not `false`. The question is unanswerable, and answering it
    // `false` would read as "this build is stale" about one that may be
    // perfectly current.
    //
    // Fails if `atTip` is defaulted to `false` — every build reported without
    // a commit would present as stale, which is a false alarm on a large
    // fraction of rows.
    const folded = foldBuildStatus([checkRun({ commitSha: null })], TIP, new Set([TIP]), NOW);
    expect(folded?.status).toBe("passing");
    expect(folded?.atTip).toBeNull();
  });

  it("reports at-tip as unknown when the item has no commit artifact", () => {
    // Nothing has been committed, so there is no tip for anything to be
    // stale against. Same reasoning as above, reached from the other side.
    const folded = foldBuildStatus([checkRun()], null, new Set(), NOW);
    expect(folded?.atTip).toBeNull();
  });
});

describe("a status that cannot be resolved", () => {
  it("reports an unreadable body as an unknown status, still returning the row", () => {
    // The boundary the brief names as "a ref that cannot be resolved",
    // reached through the status: the row exists, it was recorded at a known
    // time, and what it says cannot be read. Every one of those is reported.
    //
    // The read must NOT throw and must NOT guess. Fails if an unrecognised
    // body is ever coerced to a status — a caller writing `"success"` from a
    // build service's own vocabulary would be reported as passing.
    const folded = foldBuildStatus([checkRun({ body: "success" })], TIP, new Set([TIP]), NOW);
    expect(folded).not.toBeNull();
    expect(folded?.status).toBeNull();
    // The rest of the row is still reported, because it is still true.
    expect(folded?.ageSeconds).toBe(30);
    expect(folded?.atTip).toBe(true);
  });

  it("drops a build URL that is not a plain web address, keeping the status", () => {
    // The URL reaches a reader as a link, so a `javascript:` target is an
    // injection into whatever renders it. Dropped to `null` rather than
    // refusing the whole read — the status is the answer, the link is a
    // convenience, and losing the convenience must not lose the answer.
    for (const ref of ["javascript:alert(1)", "not a url", "https://build.example/1) [x](y)"]) {
      const folded = foldBuildStatus([checkRun({ ref })], TIP, new Set([TIP]), NOW);
      expect(folded?.url, ref).toBeNull();
      expect(folded?.status, ref).toBe("passing");
    }
  });

  it("reports a build with no URL at all, since the status is the answer", () => {
    // A build reported from a context with no URL — a local run, a script
    // reading an exit code — is a legitimate call, not a degraded one.
    const folded = foldBuildStatus([checkRun({ ref: null })], TIP, new Set([TIP]), NOW);
    expect(folded?.url).toBeNull();
    expect(folded?.status).toBe("passing");
  });

  it("passes a good build URL through, trimmed", () => {
    const folded = foldBuildStatus(
      [checkRun({ ref: "  https://build.example/runs/7  " })],
      TIP,
      new Set([TIP]),
      NOW,
    );
    expect(folded?.url).toBe("https://build.example/runs/7");
  });
});
