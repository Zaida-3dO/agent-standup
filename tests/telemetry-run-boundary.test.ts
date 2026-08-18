// The run boundary rule — MILESTONES.md #51, SCHEMA.md §11 ("A run is
// bounded by `(assignment, model, effort)`. A mid-session model or effort
// change closes the current run and opens a new one").
//
// **Needs no database, so it runs everywhere.** That is deliberate and is
// the reason the rule was extracted into a pure function at all: the cases
// most likely to be got wrong are the ones a happy path never reaches — an
// unreported model, a report arriving after silence, a change on the first
// call — and each is one assertion here against a fixture-heavy seed and a
// round trip through the ingest.
//
// **What would make this file hollow.** Testing only that a differing model
// cuts. That case is the one anybody writes and the one no plausible
// implementation gets wrong; every real defect in this rule lives in what
// happens when a field is *absent*, because absence is the common case and
// the one where "no evidence" is easy to conflate with "a different value".
// So the absence cases outnumber the change cases below, on purpose.
import { describe, expect, it } from "vitest";
import { decideRun, type OpenRunFacets } from "@/lib/telemetry/run-boundary";

/** A run that has been told both facets. */
const known: OpenRunFacets = { model: "vendor-model-a", effort: "high" };
/** A run that has been told neither — the state a run opens in when the first call reported nothing. */
const unknown: OpenRunFacets = { model: null, effort: null };

describe("decideRun — opening a run", () => {
  it("cuts when there is no open run at all", () => {
    expect(decideRun(null, { model: "vendor-model-a", effort: "high" })).toEqual({
      action: "cut",
      model: "vendor-model-a",
      effort: "high",
    });
  });

  it("cuts with null facets when there is no open run and nothing was reported", () => {
    // The run still has to exist — the calls happened and their tokens must
    // land somewhere. It simply does not know what served them.
    expect(decideRun(null, {})).toEqual({ action: "cut", model: null, effort: null });
  });
});

describe("decideRun — a change closes the run", () => {
  it("cuts on a different model", () => {
    expect(decideRun(known, { model: "vendor-model-b", effort: "high" })).toEqual({
      action: "cut",
      model: "vendor-model-b",
      effort: "high",
    });
  });

  it("cuts on a different effort with the same model", () => {
    // §11 bounds a run by the pair, and `run_scores` grades against the
    // pair: the same model at two efforts is two different things being
    // measured, so effort alone is sufficient to cut.
    expect(decideRun(known, { model: "vendor-model-a", effort: "low" })).toEqual({
      action: "cut",
      model: "vendor-model-a",
      effort: "low",
    });
  });

  it("carries the unreported facet forward onto the new run", () => {
    // A call that changed the model while reporting no effort has not said
    // the effort changed. Starting the new run's effort at unknown would
    // let the *next* call's report silently re-attribute it.
    expect(decideRun(known, { model: "vendor-model-b" })).toEqual({
      action: "cut",
      model: "vendor-model-b",
      effort: "high",
    });
  });
});

describe("decideRun — absence is not a change", () => {
  it("keeps the run when the call reports nothing", () => {
    // The case that matters most: no agent tool is obliged to report usage,
    // so a run receives silent calls routinely. Cutting on each would
    // shatter one turn into a run per call.
    expect(decideRun(known, {})).toEqual({ action: "keep" });
  });

  it("keeps the run when the call reports null facets explicitly", () => {
    expect(decideRun(known, { model: null, effort: null })).toEqual({ action: "keep" });
  });

  it("keeps the run when the call reports empty strings", () => {
    // A tool reporting `model: ""` has told us nothing. Treating it as a
    // value would make it a model name differing from every real one — a
    // cut on every such call, and an empty string stored in the column that
    // exists to say which model to price and score against.
    expect(decideRun(known, { model: "   ", effort: "" })).toEqual({ action: "keep" });
  });

  it("keeps the run when only one facet is reported and it matches", () => {
    expect(decideRun(known, { model: "vendor-model-a" })).toEqual({ action: "keep" });
  });

  it("does not cut when a known run hears silence then the same model again", () => {
    expect(decideRun(known, {})).toEqual({ action: "keep" });
    expect(decideRun(known, { model: "vendor-model-a", effort: "high" })).toEqual({
      action: "keep",
    });
  });
});

describe("decideRun — adoption, one-way and only from unknown", () => {
  it("adopts the first model a run hears rather than cutting", () => {
    // A turn commonly opens with calls carrying no usage. If the first
    // reported model cut, every turn would split into an unattributed head
    // and an attributed tail, and the head would be permanently unpriceable.
    expect(decideRun(unknown, { model: "vendor-model-a", effort: "high" })).toEqual({
      action: "adopt",
      model: "vendor-model-a",
      effort: "high",
    });
  });

  it("adopts one facet while leaving the other unknown", () => {
    expect(decideRun(unknown, { model: "vendor-model-a" })).toEqual({
      action: "adopt",
      model: "vendor-model-a",
      effort: null,
    });
  });

  it("adopts a model into a run that already knows its effort", () => {
    expect(decideRun({ model: null, effort: "high" }, { model: "vendor-model-a" })).toEqual({
      action: "adopt",
      model: "vendor-model-a",
      effort: "high",
    });
  });

  it("keeps rather than adopting when the run knows nothing and hears nothing", () => {
    expect(decideRun(unknown, {})).toEqual({ action: "keep" });
  });

  it("cuts once a run holds a model and a different one arrives", () => {
    // Adoption is one-way: it fills an unknown facet only, so a run that
    // already holds a model is cut by a differing one rather than amended.
    const adopted = decideRun(unknown, { model: "vendor-model-a" });
    expect(adopted.action).toBe("adopt");
    expect(
      decideRun({ model: "vendor-model-a", effort: null }, { model: "vendor-model-b" }),
    ).toEqual({ action: "cut", model: "vendor-model-b", effort: null });
  });
});

describe("decideRun — the comparison is exact", () => {
  it("cuts on a case difference, because a vendor ID is case-sensitive", () => {
    expect(decideRun(known, { model: "VENDOR-MODEL-A" }).action).toBe("cut");
  });

  it("does not cut on surrounding whitespace", () => {
    // Trimming happens before comparison, so a tool that pads its field
    // does not manufacture a boundary on every call.
    expect(decideRun(known, { model: "  vendor-model-a  " })).toEqual({ action: "keep" });
  });
});
