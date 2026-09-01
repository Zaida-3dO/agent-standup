// The build-status vocabulary and the two staleness primitives it is read
// with.
//
// Every claim here decides whether a crew is told a build passed. The two
// that carry the most weight are the ones about *not* guessing: an
// unrecognised status must read as unknown rather than as a pass, and an age
// must never be reported as smaller than it is.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import {
  CHECK_RUN_STATUSES,
  NON_PASSING_CHECK_RUN_STATUSES,
  checkRunAgeSeconds,
  checkRunStatusOf,
  isCheckRunStatus,
} from "@/lib/check-runs";

describe("the status vocabulary", () => {
  it("is exactly passing, failing, pending and error", () => {
    // A literal, not a loop over the constant — deriving the expectation from
    // the thing under test makes the assertion shrink with it. A fifth status
    // added without thought fails here, which is the point: a reader
    // branching on this list would read a value it does not know as unknown,
    // and a status nobody planned for is worse than no status.
    expect([...CHECK_RUN_STATUSES]).toEqual(["passing", "failing", "pending", "error"]);
  });

  it("accepts the four it knows and rejects everything else", () => {
    for (const status of ["passing", "failing", "pending", "error"]) {
      expect(isCheckRunStatus(status), status).toBe(true);
    }
    // The near-misses a caller reasoning from a build service's own
    // vocabulary would send. Each of these must be refused rather than
    // guessed at — `success` and `green` in particular would be read as a
    // pass by any lenient matcher, which is the failure mode with teeth.
    for (const value of [
      "success",
      "green",
      "failure",
      "PASSING",
      "Passing",
      "passed",
      "queued",
      "",
      " ",
      null,
      undefined,
      0,
      true,
    ]) {
      expect(isCheckRunStatus(value), String(value)).toBe(false);
    }
  });

  it("names every non-passing status, and does not name passing", () => {
    // The set exists so a caller never writes `status !== "passing"` and
    // thereby reports a build still running as a broken one. Fails if
    // `passing` leaks in (which would make the set meaningless) or if any
    // non-passing status is dropped from it (which would let that status be
    // treated as a green build).
    expect([...NON_PASSING_CHECK_RUN_STATUSES].sort()).toEqual(["error", "failing", "pending"]);
    expect(NON_PASSING_CHECK_RUN_STATUSES).not.toContain("passing");
    // Derived cross-check: the two lists must partition the vocabulary, so a
    // status added to one and forgotten in the other is caught here rather
    // than at a call site.
    for (const status of CHECK_RUN_STATUSES) {
      const isNonPassing = NON_PASSING_CHECK_RUN_STATUSES.includes(status);
      expect(isNonPassing, status).toBe(status !== "passing");
    }
  });
});

describe("reading a status off an artifact body", () => {
  it("reads each of the four back", () => {
    for (const status of CHECK_RUN_STATUSES) {
      expect(checkRunStatusOf(status)).toBe(status);
    }
  });

  it("treats surrounding whitespace as storage noise, not a different status", () => {
    expect(checkRunStatusOf("  passing  ")).toBe("passing");
    expect(checkRunStatusOf("\nfailing\t")).toBe("failing");
  });

  it("reports an unrecognised body as unknown rather than guessing a pass", () => {
    // THE claim of this module. A body this vocabulary cannot read must
    // produce `null` — "I learned nothing" — and never a status.
    //
    // `"passing, with one flake"` and `"passed"` are the two that matter: a
    // prefix match or a stem match would read both as `passing`, which is a
    // crew told to merge on a build that reported something else. Fails the
    // moment the read is loosened in the passing direction.
    for (const body of [
      "passing, with one flake",
      "passed",
      "success",
      "green",
      "PASSING",
      "not passing",
      "some old note",
      "",
      "   ",
    ]) {
      expect(checkRunStatusOf(body), body).toBeNull();
    }
  });

  it("reports an absent body as unknown", () => {
    // A row with no status recorded says nothing about a build. Fails if a
    // default is ever introduced here — there is no safe direction to guess a
    // build in, which is the asymmetry with a pull request's open/closed.
    expect(checkRunStatusOf(null)).toBeNull();
    expect(checkRunStatusOf(undefined)).toBeNull();
  });
});

describe("how old a status is", () => {
  it("reports whole seconds since it was recorded", () => {
    const recordedAt = new Date("2026-09-01T10:00:00.000Z");
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:00.000Z"))).toBe(0);
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:45.000Z"))).toBe(45);
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T11:30:00.000Z"))).toBe(5400);
    // A day-old status is the case the whole field exists for: the number has
    // to stay large and legible rather than wrapping or saturating.
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-02T10:00:00.000Z"))).toBe(86_400);
  });

  it("floors rather than rounds, so an age is never reported as larger than it is", () => {
    // 1.9 seconds is one whole second elapsed, not two. Rounding up would
    // overstate staleness — the safe direction, but still a wrong number, and
    // the assertion pins which direction was chosen so a later change to
    // `Math.round` is a failure rather than a silent drift.
    const recordedAt = new Date("2026-09-01T10:00:00.000Z");
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:01.900Z"))).toBe(1);
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:00.999Z"))).toBe(0);
  });

  it("floors a clock skew at zero rather than reporting a negative age", () => {
    // Reachable in practice, not defensive: the recorded time comes from the
    // database's clock and `now` from the reading process's, so a status
    // written during the same request can come back stamped slightly ahead.
    //
    // Fails if the floor is removed — the age would go negative, and a
    // consumer formatting "recorded Ns ago" would render "recorded -1s ago".
    const recordedAt = new Date("2026-09-01T10:00:05.000Z");
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:00.000Z"))).toBe(0);
    expect(checkRunAgeSeconds(recordedAt, new Date("2026-09-01T10:00:04.500Z"))).toBe(0);
  });
});
