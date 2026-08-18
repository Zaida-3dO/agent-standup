// Where one run ends and the next begins — MILESTONES.md #51 ("Runs: a new
// run whenever the model or effort changes; the hook reports the model per
// call"), SCHEMA.md §11.
//
// §11 states the rule in one sentence: "**A run is bounded by `(assignment,
// model, effort)`.** A mid-session model or effort change **closes the
// current run and opens a new one**". This module is that sentence as a
// pure function, and nothing else — no database, no clock, no ids. The
// operation that ingests a batch decides what to *do* with the answer; this
// decides what the answer is.
//
// ── Why it is separated from the ingest at all ──────────────────────────
//
// Because the rule has cases the ingest's happy path never exercises, and a
// boundary decision buried inside a loop that also writes rows can only be
// tested by writing rows and reading them back. Every case below —
// unreported model, a report arriving after an unreported one, a change on
// the very first call of a batch — is a one-line assertion against a
// function and a fixture-heavy database round trip against an operation.
// The rule is the part most likely to be got subtly wrong, so it is the
// part made cheapest to test.
//
// ── The rule, and the three ways it is not obvious ──────────────────────
//
// **1. An unreported model does not close a run.** No agent tool is obliged
// to report the field (`ReportedUsage` makes all of it optional), so a run
// will routinely receive calls carrying nothing. Treating "not reported" as
// a distinct value would cut a new run on every such call and then cut
// another on the next reported one, shattering one turn into a run per call
// and attributing each fragment's score to a model nobody recorded. So an
// unreported model reads as *no evidence*, and no evidence never closes
// anything.
//
// **2. But an unreported model does not overwrite one either.** A run that
// learned it was served by a named model keeps that fact when a later call
// arrives silent. The alternative — clearing the run's model back to
// unknown — would let one unreported call erase the attribution of every
// call before it in the same run, and `model` is NOT NULL on the table
// precisely because a run with no model cannot be scored or priced.
//
// **3. A run that never learned a model adopts the first one it hears.**
// This is the case that decides whether capture works at all. A turn
// commonly opens with calls whose payloads carry no usage — a `Read`
// before the first model response — and if the first *reported* model cut a
// new run, every turn would be split into an unattributed head and an
// attributed tail, with the head permanently unpriceable. Adopting instead
// attributes those calls to the model that in fact served them. The
// adoption is one-way and happens only from unknown: once a run holds a
// model, a *different* reported model always cuts.
//
// The same three rules apply to `effort`, independently. Either field
// changing is sufficient to cut, because §11 bounds a run by both and
// `run_scores` grades against the pair.

/**
 * What an open run currently believes it was served by.
 *
 * Both fields are nullable because a run can legitimately exist having
 * never been told either — see rule 3 above. They are read together and
 * never separately: a decision about one field is not a decision about the
 * run.
 */
export interface OpenRunFacets {
  readonly model: string | null;
  readonly effort: string | null;
}

/** What one call reported. Both absent is the common case, not an error. */
export interface ReportedFacets {
  readonly model?: string | null;
  readonly effort?: string | null;
}

/**
 * What the ingest should do with one call, given the run currently open.
 *
 * Three outcomes rather than a boolean, because "keep the run as it is" and
 * "keep the run and record what it just learned" are different writes and
 * collapsing them loses rule 3: a caller told only "do not cut" would never
 * store the first model a run heard, and the run would stay unattributed
 * forever while every call in it reported the same model.
 */
export type RunDecision =
  /** The call belongs to the open run, unchanged. */
  | { readonly action: "keep" }
  /**
   * The call belongs to the open run, and the run learns a facet it did not
   * have. `model` and `effort` are the run's values *after* adoption, so a
   * caller writes them without re-deriving anything.
   */
  | { readonly action: "adopt"; readonly model: string | null; readonly effort: string | null }
  /**
   * The open run must be closed and a new one opened for this call. The
   * facets carried are the new run's, which are the reported values where
   * reported and the closed run's where not — because a call that changes
   * the model while reporting no effort has not told us the effort changed,
   * and carrying the previous value forward is the only reading consistent
   * with rule 1.
   */
  | { readonly action: "cut"; readonly model: string | null; readonly effort: string | null };

/**
 * Decides one call against the open run, or against no open run at all.
 *
 * `open` is `null` when the assignment has no run in progress — the first
 * call after a claim, or the first after a previous run was closed. That is
 * always a `cut`, and stating it here rather than at the call site keeps
 * every path that opens a run going through the same rule.
 */
export function decideRun(open: OpenRunFacets | null, reported: ReportedFacets): RunDecision {
  const model = normalise(reported.model);
  const effort = normalise(reported.effort);

  if (open === null) {
    return { action: "cut", model, effort };
  }

  // A reported value that differs from what the run holds closes it. Note
  // the order of the two conditions: a null report is filtered out *first*,
  // so "unreported" can never be compared against "known" and read as a
  // difference. That is rule 1, and inverting these two lines is the single
  // most plausible way to get this function wrong — the result would cut a
  // run on every unreported call, which is behaviour a happy-path test
  // where every call reports a model cannot see.
  const modelChanged = model !== null && open.model !== null && model !== open.model;
  const effortChanged = effort !== null && open.effort !== null && effort !== open.effort;

  if (modelChanged || effortChanged) {
    // Where the *other* facet was not reported on this call, the new run
    // inherits the open run's value rather than starting unknown. Nothing
    // said it changed, and starting it unknown would make the new run
    // adopt whatever the next call happened to report — turning an
    // unreported field into a silent re-attribution one call later.
    return {
      action: "cut",
      model: model ?? open.model,
      effort: effort ?? open.effort,
    };
  }

  // Rule 3: adoption, one-way, only from unknown.
  const adoptsModel = model !== null && open.model === null;
  const adoptsEffort = effort !== null && open.effort === null;

  if (adoptsModel || adoptsEffort) {
    return {
      action: "adopt",
      model: adoptsModel ? model : open.model,
      effort: adoptsEffort ? effort : open.effort,
    };
  }

  return { action: "keep" };
}

/**
 * A reported facet as the comparison may use it.
 *
 * Absent, null, and blank all collapse to `null` — "nothing was reported".
 * Blank is included deliberately: a tool reporting `model: ""` has told us
 * nothing, and treating an empty string as a value would make it a *model
 * name* that differs from every real one, cutting a run on every such call
 * and then storing an empty string in a NOT NULL column that exists to
 * identify which model to price and score against.
 */
function normalise(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
