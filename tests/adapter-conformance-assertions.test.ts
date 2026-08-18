// The negative controls for the conformance assertions — SCHEMA.md §22,
// MILESTONES.md #94.
//
// §22 asks for "one negative control per claim", and this is the file that
// pays it. Each assertion is handed input that ought to fail — a driver
// returning a different code, a guard with no case, an operation with only
// an accepting case, an adapter exposing an unmapped operation — and is
// asserted to *report* the failure. Every one is paired with a positive
// control on input that ought to pass, because a function that returned a
// finding unconditionally would satisfy the negative half alone and be
// worthless.
//
// This is the reason the four assertions are pure functions over observed
// results rather than `it()` bodies inside the harness: an assertion written
// inline can only ever be run against the real tree, where it is expected to
// pass, and a check that has only ever been observed to pass has never been
// run against the thing it exists to catch.
//
// No database. These are functions over plain data, and gating them on
// Postgres would mean the controls skip in exactly the runs where somebody
// is moving fast enough to break the harness.
import { describe, expect, it } from "vitest";
import {
  checkAcceptAndReject,
  checkCompleteness,
  checkGuardCoverage,
  checkIdenticalOutcomes,
  renderRejection,
  type Observation,
} from "@/lib/conformance/assertions";

/** A shorthand for one observed result, so a case reads as its claim. */
function observed(
  driver: string,
  caseName: string,
  operation: string,
  outcome: "accepted" | { code: string; fields?: string[]; guard?: string },
): Observation {
  if (outcome === "accepted") return { driver, caseName, operation, accepted: true };
  return {
    driver,
    caseName,
    operation,
    accepted: false,
    rejection: {
      code: outcome.code as never,
      fields: outcome.fields ?? [],
      ...(outcome.guard === undefined ? {} : { guard: outcome.guard }),
    },
  };
}

describe("renderRejection", () => {
  it("sorts fields, so two adapters collecting the same set in a different order compare equal", () => {
    const a = renderRejection({ code: "invalid_input", fields: ["b", "a"] });
    const b = renderRejection({ code: "invalid_input", fields: ["a", "b"] });
    expect(a).toBe(b);
  });

  it("distinguishes an absent guard from one, so a rejection cannot borrow coverage it lacks", () => {
    const withGuard = renderRejection({
      code: "guard_rejected",
      fields: [],
      guard: "merge.requires_commit",
    });
    const without = renderRejection({ code: "guard_rejected", fields: [] });
    expect(withGuard).not.toBe(without);
  });
});

describe("assertion 1 — identical outcomes", () => {
  it("passes when every driver reached the same outcome", () => {
    const findings = checkIdenticalOutcomes([
      observed("http", "get_item refuses a missing id", "get_item", {
        code: "not_found",
        fields: ["id"],
      }),
      observed("cli", "get_item refuses a missing id", "get_item", {
        code: "not_found",
        fields: ["id"],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  // The negative control: one driver refusing with a different code is the
  // exact defect §22 exists to catch — a rule implemented inside an adapter
  // and enforced for that adapter's callers only.
  it("reports a driver that returned a different code", () => {
    const findings = checkIdenticalOutcomes([
      observed("http", "case", "get_item", { code: "not_found", fields: ["id"] }),
      observed("cli", "case", "get_item", { code: "invalid_input", fields: ["id"] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.assertion).toBe("identical-outcomes");
    expect(findings[0]?.message).toContain("drivers disagreed");
    expect(findings[0]?.message).toContain("cli");
    expect(findings[0]?.message).toContain("http");
  });

  it("reports a driver that accepted what another refused", () => {
    const findings = checkIdenticalOutcomes([
      observed("http", "case", "create_item", "accepted"),
      observed("mcp_http", "case", "create_item", { code: "invalid_input", fields: ["title"] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("accepted");
  });

  it("reports a driver whose rejection named a different guard", () => {
    const findings = checkIdenticalOutcomes([
      observed("http", "case", "transition_item", {
        code: "guard_rejected",
        guard: "merge.requires_commit",
      }),
      observed("cli", "case", "transition_item", {
        code: "guard_rejected",
        guard: "artifact.plan_approval",
      }),
    ]);
    expect(findings).toHaveLength(1);
  });

  it("does not treat a single observation as a disagreement — that is what a waived operation looks like", () => {
    expect(checkIdenticalOutcomes([observed("http", "case", "backfill", "accepted")])).toEqual([]);
  });
});

describe("assertion 2 — accept and reject per operation", () => {
  it("passes when an operation has both halves", () => {
    const findings = checkAcceptAndReject([
      observed("http", "accepts", "list_items", "accepted"),
      observed("http", "refuses", "list_items", { code: "invalid_input" }),
    ]);
    expect(findings).toEqual([]);
  });

  // The negative control §22 names outright: "an operation with only an
  // accepting case". A guard that never refuses anything passes a
  // happy-path suite and protects nothing.
  it("reports an operation with only an accepting case", () => {
    const findings = checkAcceptAndReject([observed("http", "accepts", "list_items", "accepted")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.assertion).toBe("accept-and-reject");
    expect(findings[0]?.message).toContain("no rejecting case");
  });

  it("reports an operation with only a rejecting case", () => {
    const findings = checkAcceptAndReject([
      observed("http", "refuses", "list_items", { code: "invalid_input" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no accepting case");
  });
});

describe("assertion 3 — guard coverage", () => {
  it("passes when every expected guard was observed refusing something", () => {
    const findings = checkGuardCoverage(
      ["merge.requires_commit"],
      [
        observed("http", "case", "transition_item", {
          code: "guard_rejected",
          guard: "merge.requires_commit",
        }),
      ],
    );
    expect(findings).toEqual([]);
  });

  // The negative control: a guard nothing ever provoked. This is the
  // assertion that keeps the suite honest a year from now — a new guard
  // fails the build until it has a case.
  it("reports a registered guard that no case provoked", () => {
    const findings = checkGuardCoverage(
      ["merge.requires_commit", "artifact.plan_approval"],
      [
        observed("http", "case", "transition_item", {
          code: "guard_rejected",
          guard: "merge.requires_commit",
        }),
      ],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.assertion).toBe("guard-coverage");
    expect(findings[0]?.message).toContain("artifact.plan_approval");
    expect(findings[0]?.message).toContain("never observed refusing");
  });

  // Coverage is computed from what the service returned, never from what a
  // case declared — a case can name one rule while the service refuses on
  // another with the same code, and a suite that trusted the declaration
  // would record coverage it does not have.
  it("does not credit a guard from a rejection that named a different one", () => {
    const findings = checkGuardCoverage(
      ["merge.requires_visual_review"],
      [
        observed("http", "case", "transition_item", {
          code: "guard_rejected",
          guard: "merge.requires_commit",
        }),
      ],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("merge.requires_visual_review");
  });

  // §22's "direct assertion that the guard registry is not empty", in the
  // function itself: an assertion evaluated over an empty set passes
  // forever and silently, so the empty set has to be a finding rather than
  // a vacuous pass.
  it("refuses to pass vacuously on an empty expected set", () => {
    const findings = checkGuardCoverage([], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("empty");
  });
});

describe("assertion 4 — adapter completeness", () => {
  it("passes when an adapter exposes every registered operation", () => {
    const findings = checkCompleteness(
      ["get_item", "list_items"],
      [{ adapter: "http", exposes: ["get_item", "list_items"], waived: [] }],
    );
    expect(findings).toEqual([]);
  });

  it("passes when what it does not expose carries a waiver", () => {
    const findings = checkCompleteness(
      ["get_item", "backfill"],
      [{ adapter: "mcp_http", exposes: ["get_item"], waived: ["backfill"] }],
    );
    expect(findings).toEqual([]);
  });

  // The negative control §22 names: "an adapter exposing an unmapped
  // operation" — an adapter reaching for something the service does not
  // have, which is how a surface grows a rule of its own.
  it("reports an adapter exposing an operation nothing registered", () => {
    const findings = checkCompleteness(
      ["get_item"],
      [{ adapter: "http", exposes: ["get_item", "invent_item"], waived: [] }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.assertion).toBe("completeness");
    expect(findings[0]?.message).toContain("invent_item");
    expect(findings[0]?.message).toContain("not a registered service operation");
  });

  it("reports an unwaived absence", () => {
    const findings = checkCompleteness(
      ["get_item", "backfill"],
      [{ adapter: "http", exposes: ["get_item"], waived: [] }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("carries no waiver");
  });

  // A waiver whose operation the adapter exposes anyway is a reason on
  // record for a decision that was reversed — the sentence a reader trusts
  // while the code does the opposite.
  it("reports a waiver the adapter contradicts by exposing the operation", () => {
    const findings = checkCompleteness(
      ["backfill"],
      [{ adapter: "mcp_http", exposes: ["backfill"], waived: ["backfill"] }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("exposes it anyway");
  });
});
