// The budget-window editor's model — MILESTONES.md #87, SCHEMA.md §17.4.
//
// Every edit is a pure function from a draft to a draft. React holds the
// value and calls these; nothing here imports React, touches a DOM, or
// fetches. That is the same split `chart.ts`, `describe.ts` and
// `scrubber.ts` already use on this page, and it exists for a concrete
// reason: the harness runs `environment: "node"` with no DOM, so behaviour
// proved as data is behaviour actually proved.
//
// ── Why a draft is *text*, not a parsed window ──────────────────────────
//
// A form holds what somebody has typed, and half-typed input is not a
// number. `"1e"`, `""` and `"-"` are all states a field passes through on
// the way to a legal value, and a model that stored `number` would have to
// invent one for each — which is how a field fights back while you type.
// So a draft holds strings, and `windowFromDraft` is the single place that
// decides whether the strings amount to a window.
//
// That also gives the collision drawing its live behaviour for free: the
// draft parses on every keystroke, and when it parses the *result* goes
// straight to `findCrossings`, so the chart marks a collision as it appears
// rather than after a save round-trip.
import {
  boundaryAt,
  type BandKey,
  type Boundary,
  type BudgetWindow,
  type BudgetWindows,
} from "../settings/budget-windows";

/** The three boundaries, in the order a form shows them. */
export const EDIT_BAND_KEYS = ["selective", "windDown", "stop"] as const;

/** The kinds a boundary can be, in the order the kind picker offers them. */
export const BOUNDARY_KINDS = ["constant", "linear", "schedule"] as const;

export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export type PerUnit = "hour" | "day";

/** A schedule entry being edited — anchor from either end, holding a value. */
export interface EntryDraft {
  /**
   * Which end the anchor is written from. Kept as part of the draft rather
   * than inferred, because "after 2 days" and "in the final 2 days" are the
   * same two characters typed and a different rule meant.
   */
  readonly anchorFrom: "elapsed" | "remaining";
  readonly anchorAmount: string;
  readonly anchorPer: PerUnit;
  /** A schedule entry carries a constant or a linear — never a schedule. */
  readonly valueKind: "constant" | "linear";
  readonly constantValue: string;
  readonly slope: string;
  readonly offset: string;
  readonly per: PerUnit;
}

/**
 * One boundary being edited.
 *
 * All three kinds' fields are held at once, and the kind selects which are
 * read. That is deliberate: switching kind to look at another shape and
 * switching back should not silently empty what you had typed, and a union
 * that dropped the other kinds' fields would do exactly that.
 */
export interface BoundaryDraft {
  readonly kind: BoundaryKind;
  readonly constantValue: string;
  readonly slope: string;
  readonly offset: string;
  readonly per: PerUnit;
  readonly entries: readonly EntryDraft[];
}

export interface WindowDraft {
  readonly enabled: boolean;
  readonly lengthHours: string;
  readonly boundaries: Readonly<Record<BandKey, BoundaryDraft>>;
}

/** The whole editor's state: the windows, and the name each is filed under. */
export interface WindowsDraft {
  /** Insertion-ordered, so a window added stays where it was put. */
  readonly names: readonly string[];
  readonly windows: Readonly<Record<string, WindowDraft>>;
}

/** `15` not `15.00`, matching how `describe.ts` prints the same numbers. */
function numberToField(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000);
}

/**
 * A field's number, or `null` when it is not one *yet*.
 *
 * Blank is `null` rather than `0`, because an empty box means "not said"
 * and a zero is a value somebody chose. Treating them the same is how a
 * form silently saves a boundary nobody wrote.
 */
export function fieldNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyEntry(): EntryDraft {
  return {
    anchorFrom: "elapsed",
    anchorAmount: "0",
    anchorPer: "hour",
    valueKind: "constant",
    constantValue: "",
    slope: "",
    offset: "",
    per: "hour",
  };
}

/** A boundary draft with nothing filled in, of the given kind. */
export function emptyBoundaryDraft(kind: BoundaryKind = "constant"): BoundaryDraft {
  return {
    kind,
    constantValue: "",
    slope: "",
    offset: "",
    per: "hour",
    entries: [emptyEntry()],
  };
}

/** A stored boundary, opened for editing. */
export function boundaryToDraft(boundary: Boundary): BoundaryDraft {
  const base = emptyBoundaryDraft(boundary.kind);
  switch (boundary.kind) {
    case "constant":
      return { ...base, constantValue: numberToField(boundary.value) };
    case "linear":
      return {
        ...base,
        slope: numberToField(boundary.slope),
        offset: numberToField(boundary.offset),
        per: boundary.per,
      };
    case "schedule":
      return {
        ...base,
        entries: boundary.entries.map((entry) => {
          const anchorFrom = "elapsed" in entry.at ? "elapsed" : "remaining";
          const anchorAmount =
            "elapsed" in entry.at
              ? entry.at.elapsed
              : (entry.at as { remaining: number }).remaining;
          const value = entry.value;
          return {
            anchorFrom,
            anchorAmount: numberToField(anchorAmount),
            anchorPer: entry.at.per,
            valueKind: value.kind,
            constantValue: value.kind === "constant" ? numberToField(value.value) : "",
            slope: value.kind === "linear" ? numberToField(value.slope) : "",
            offset: value.kind === "linear" ? numberToField(value.offset) : "",
            per: value.kind === "linear" ? value.per : "hour",
          } satisfies EntryDraft;
        }),
      };
  }
}

/** A stored window, opened for editing. */
export function windowToDraft(window: BudgetWindow): WindowDraft {
  return {
    enabled: window.enabled,
    lengthHours: numberToField(window.lengthHours),
    boundaries: {
      selective: boundaryToDraft(window.boundaries.selective),
      windDown: boundaryToDraft(window.boundaries.windDown),
      stop: boundaryToDraft(window.boundaries.stop),
    },
  };
}

/** The whole stored map, opened for editing. Names sorted, as the viewer shows them. */
export function windowsToDraft(windows: BudgetWindows): WindowsDraft {
  const names = Object.keys(windows).sort();
  const drafts: Record<string, WindowDraft> = {};
  for (const name of names) {
    const window = windows[name];
    if (window === undefined) continue;
    drafts[name] = windowToDraft(window);
  }
  return { names, windows: drafts };
}

/**
 * A boundary draft as a `Boundary`, or `null` when it is not one yet.
 *
 * `null` means "incomplete", not "invalid" — an empty field is a form in
 * progress. Whether a *complete* set of boundaries is coherent is
 * `findCrossings`'s question and this function deliberately does not
 * duplicate that judgement.
 */
export function boundaryFromDraft(draft: BoundaryDraft): Boundary | null {
  switch (draft.kind) {
    case "constant": {
      const value = fieldNumber(draft.constantValue);
      return value === null ? null : { kind: "constant", value };
    }
    case "linear": {
      const slope = fieldNumber(draft.slope);
      const offset = fieldNumber(draft.offset);
      if (slope === null || offset === null) return null;
      return { kind: "linear", slope, offset, per: draft.per };
    }
    case "schedule": {
      if (draft.entries.length === 0) return null;
      const built = draft.entries.map((entry) => {
        const amount = fieldNumber(entry.anchorAmount);
        // A negative anchor is refused here rather than clamped: the schema
        // says `nonnegative`, and silently turning "-2" into 0 would store
        // a rule nobody wrote.
        if (amount === null || amount < 0) return null;
        const at =
          entry.anchorFrom === "elapsed"
            ? ({ elapsed: amount, per: entry.anchorPer } as const)
            : ({ remaining: amount, per: entry.anchorPer } as const);
        if (entry.valueKind === "constant") {
          const value = fieldNumber(entry.constantValue);
          return value === null ? null : { at, value: { kind: "constant", value } as const };
        }
        const slope = fieldNumber(entry.slope);
        const offset = fieldNumber(entry.offset);
        if (slope === null || offset === null) return null;
        return { at, value: { kind: "linear", slope, offset, per: entry.per } as const };
      });
      if (built.some((entry) => entry === null)) return null;
      return {
        kind: "schedule",
        entries: built as NonNullable<(typeof built)[number]>[],
      };
    }
  }
}

/** A window draft as a `BudgetWindow`, or `null` when it is not one yet. */
export function windowFromDraft(draft: WindowDraft): BudgetWindow | null {
  const lengthHours = fieldNumber(draft.lengthHours);
  if (lengthHours === null || lengthHours <= 0) return null;
  const selective = boundaryFromDraft(draft.boundaries.selective);
  const windDown = boundaryFromDraft(draft.boundaries.windDown);
  const stop = boundaryFromDraft(draft.boundaries.stop);
  if (selective === null || windDown === null || stop === null) return null;
  return {
    enabled: draft.enabled,
    lengthHours,
    boundaries: { selective, windDown, stop },
  };
}

/**
 * Why a draft cannot be saved yet, in the reader's words — or `null` when
 * it can.
 *
 * Separate from `windowFromDraft` returning `null` because "it does not
 * parse" is not something to show somebody. This names the first field
 * that is not ready, which is what turns a disabled Save button from a
 * mystery into an instruction.
 */
export function draftIncompleteness(draft: WindowDraft): string | null {
  const lengthHours = fieldNumber(draft.lengthHours);
  if (lengthHours === null) return "Give the window a length in hours.";
  if (lengthHours <= 0) return "The window's length must be more than zero hours.";
  for (const key of EDIT_BAND_KEYS) {
    const boundary = draft.boundaries[key];
    if (boundaryFromDraft(boundary) !== null) continue;
    const label = BAND_FIELD_LABELS[key];
    if (boundary.kind === "schedule") {
      return `Every step of the ${label} schedule needs a moment and a value.`;
    }
    return `Fill in every field of the ${label} boundary.`;
  }
  return null;
}

/** Band names as a form addresses them. */
export const BAND_FIELD_LABELS: Readonly<Record<BandKey, string>> = Object.freeze({
  selective: "Selective",
  windDown: "Wind down",
  stop: "Stop",
});

/** The whole draft as the value to store, or `null` when any window is incomplete. */
export function windowsFromDraft(draft: WindowsDraft): BudgetWindows | null {
  const out: Record<string, BudgetWindow> = {};
  for (const name of draft.names) {
    const windowDraft = draft.windows[name];
    if (windowDraft === undefined) return null;
    const window = windowFromDraft(windowDraft);
    if (window === null) return null;
    out[name] = window;
  }
  return out;
}

// ── Edits ───────────────────────────────────────────────────────────────

/** One window's draft, set to a new value. */
export function withWindow(draft: WindowsDraft, name: string, window: WindowDraft): WindowsDraft {
  if (!draft.names.includes(name)) return draft;
  return { ...draft, windows: { ...draft.windows, [name]: window } };
}

/** One boundary within a window draft, set to a new value. */
export function withBoundary(
  draft: WindowDraft,
  key: BandKey,
  boundary: BoundaryDraft,
): WindowDraft {
  return { ...draft, boundaries: { ...draft.boundaries, [key]: boundary } };
}

/**
 * Changes a boundary's kind, keeping every kind's fields.
 *
 * The other kinds' text is retained rather than cleared — see
 * `BoundaryDraft`. Switching to `schedule` with no steps yet seeds one,
 * because a schedule with zero entries is not representable and an empty
 * list gives nothing to type into.
 */
export function withKind(boundary: BoundaryDraft, kind: BoundaryKind): BoundaryDraft {
  if (kind === boundary.kind) return boundary;
  const entries = boundary.entries.length === 0 ? [emptyEntry()] : boundary.entries;
  return { ...boundary, kind, entries };
}

/** Adds a step to a schedule, copying the last one — a step is usually a variation. */
export function withEntryAdded(boundary: BoundaryDraft): BoundaryDraft {
  const last = boundary.entries[boundary.entries.length - 1];
  return { ...boundary, entries: [...boundary.entries, last ? { ...last } : emptyEntry()] };
}

/**
 * Removes a step.
 *
 * The last one cannot be removed: `entries` is `.min(1)` in the schema, so
 * an empty schedule is unsaveable, and a form that let you reach that state
 * would be offering a dead end.
 */
export function withEntryRemoved(boundary: BoundaryDraft, index: number): BoundaryDraft {
  if (boundary.entries.length <= 1) return boundary;
  if (index < 0 || index >= boundary.entries.length) return boundary;
  return { ...boundary, entries: boundary.entries.filter((_, i) => i !== index) };
}

/** One step of a schedule, set to a new value. */
export function withEntry(
  boundary: BoundaryDraft,
  index: number,
  entry: EntryDraft,
): BoundaryDraft {
  if (index < 0 || index >= boundary.entries.length) return boundary;
  return { ...boundary, entries: boundary.entries.map((e, i) => (i === index ? entry : e)) };
}

/**
 * Adds a window under a new name.
 *
 * Refuses a blank name and refuses to overwrite an existing one, returning
 * the reason. A silent overwrite here would destroy a window by typing a
 * name, which is the one mistake this form must not allow.
 */
export function withWindowAdded(
  draft: WindowsDraft,
  name: string,
):
  | { readonly ok: true; readonly draft: WindowsDraft }
  | { readonly ok: false; readonly message: string } {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, message: "Give the window a name." };
  if (draft.names.includes(trimmed)) {
    return { ok: false, message: `There is already a window called "${trimmed}".` };
  }
  return {
    ok: true,
    draft: {
      names: [...draft.names, trimmed],
      windows: { ...draft.windows, [trimmed]: presetDraft("steady") },
    },
  };
}

/** Removes a window from the draft. Saving is what makes it a deletion. */
export function withWindowRemoved(draft: WindowsDraft, name: string): WindowsDraft {
  if (!draft.names.includes(name)) return draft;
  const windows = { ...draft.windows };
  delete windows[name];
  return { names: draft.names.filter((n) => n !== name), windows };
}

// ── Presets ─────────────────────────────────────────────────────────────

/**
 * A named starting point.
 *
 * Presets exist because the three kinds are the *vocabulary*, not the
 * answer — somebody opening this page wants "the usual weekly shape", and
 * deriving that from three boundary kinds is exactly the step that sends
 * people back to editing raw JSON. Each is a legal, non-crossing window, so
 * picking one never lands the editor in a faulted state.
 */
export const PRESETS = ["steady", "tightening", "final-hour"] as const;

export type PresetName = (typeof PRESETS)[number];

export const PRESET_LABELS: Readonly<Record<PresetName, string>> = Object.freeze({
  steady: "Steady",
  tightening: "Tightening",
  "final-hour": "Strict final hour",
});

export const PRESET_HELP: Readonly<Record<PresetName, string>> = Object.freeze({
  steady: "Three fixed boundaries at 50, 75 and 90% that do not move for the whole window.",
  tightening:
    "Boundaries that fall steadily as the window elapses, so the same spend counts for more later on.",
  "final-hour":
    "Fixed for most of the window, then a stricter set of boundaries for the last hour.",
});

/** A preset as a draft, ready to edit. */
export function presetDraft(name: PresetName): WindowDraft {
  return windowToDraft(presetWindow(name));
}

/**
 * A preset as a window.
 *
 * Written as model values rather than as draft text so that the property
 * that matters — each preset is coherent — is checkable by handing it
 * straight to `findCrossings`.
 */
export function presetWindow(name: PresetName): BudgetWindow {
  switch (name) {
    case "steady":
      return {
        enabled: true,
        lengthHours: 168,
        boundaries: {
          selective: { kind: "constant", value: 50 },
          windDown: { kind: "constant", value: 75 },
          stop: { kind: "constant", value: 90 },
        },
      };
    case "tightening":
      // Slopes are negative and equal, so the three lines fall in parallel
      // and keep their order for the whole window — which is what makes
      // this preset coherent by construction rather than by luck.
      return {
        enabled: true,
        lengthHours: 168,
        boundaries: {
          selective: { kind: "linear", slope: -2, offset: 60, per: "day" },
          windDown: { kind: "linear", slope: -2, offset: 80, per: "day" },
          stop: { kind: "linear", slope: -2, offset: 95, per: "day" },
        },
      };
    case "final-hour":
      return {
        enabled: true,
        lengthHours: 5,
        boundaries: {
          selective: {
            kind: "schedule",
            entries: [
              { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 60 } },
              { at: { remaining: 1, per: "hour" }, value: { kind: "constant", value: 40 } },
            ],
          },
          windDown: {
            kind: "schedule",
            entries: [
              { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 80 } },
              { at: { remaining: 1, per: "hour" }, value: { kind: "constant", value: 60 } },
            ],
          },
          stop: {
            kind: "schedule",
            entries: [
              { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 95 } },
              { at: { remaining: 1, per: "hour" }, value: { kind: "constant", value: 80 } },
            ],
          },
        },
      };
  }
}

// ── Drawing a collision ─────────────────────────────────────────────────

/**
 * The bands a problem implicates, for highlighting them in the form.
 *
 * Reads `detail` when it is there and falls back to naming nothing rather
 * than to guessing from the sentence: a highlight on the wrong field is
 * worse than no highlight, because it sends somebody to edit a boundary
 * that is not at fault.
 */
export function bandsInProblem(problem: { detail?: unknown }): BandKey[] {
  const detail = problem.detail as
    { kind: string; band?: BandKey; lower?: BandKey; upper?: BandKey } | undefined;
  if (detail === undefined) return [];
  if (detail.kind === "mis-ordered") {
    return [detail.lower, detail.upper].filter((b): b is BandKey => b !== undefined);
  }
  return detail.band === undefined ? [] : [detail.band];
}

/**
 * Where on the chart's y axis a problem should be marked, as a percentage,
 * or `null` when it has no single height.
 *
 * A mis-ordering is marked at the midpoint of the two values, which is
 * where the lines have swapped — the one point that reads as "these two
 * crossed here" rather than as a mark on one of them.
 */
export function problemPercent(problem: { detail?: unknown }): number | null {
  const detail = problem.detail as
    { kind: string; value?: number; lowerValue?: number; upperValue?: number } | undefined;
  if (detail === undefined) return null;
  if (detail.kind === "out-of-range") {
    return typeof detail.value === "number" ? Math.min(Math.max(detail.value, 0), 100) : null;
  }
  if (detail.kind === "mis-ordered") {
    const { lowerValue, upperValue } = detail;
    if (typeof lowerValue !== "number" || typeof upperValue !== "number") return null;
    return Math.min(Math.max((lowerValue + upperValue) / 2, 0), 100);
  }
  return null;
}

/**
 * A collision said the way somebody reading the form needs it: which two
 * boundaries, in their form labels, and when.
 *
 * This is the sentence AC2 is about. `problem.message` uses the *schema's*
 * key spellings (`windDown`) because that is what a stored-value error has
 * to say; a person looking at a field labelled "Wind down" needs the label
 * they can see.
 */
export function describeProblem(problem: {
  atHours: number;
  message: string;
  detail?: unknown;
}): string {
  const detail = problem.detail as
    | {
        kind: string;
        band?: BandKey;
        value?: number;
        lower?: BandKey;
        lowerValue?: number;
        upper?: BandKey;
        upperValue?: number;
      }
    | undefined;
  if (detail === undefined) return problem.message;
  const when = describeWhen(problem.atHours);
  switch (detail.kind) {
    case "missing":
      return detail.band === undefined
        ? problem.message
        : `${BAND_FIELD_LABELS[detail.band]} has no value ${when}.`;
    case "out-of-range":
      return detail.band === undefined || detail.value === undefined
        ? problem.message
        : `${BAND_FIELD_LABELS[detail.band]} reaches ${round(detail.value)}% ${when}, outside 0–100%.`;
    case "mis-ordered": {
      const { lower, upper, lowerValue, upperValue } = detail;
      if (lower === undefined || upper === undefined) return problem.message;
      if (lowerValue === undefined || upperValue === undefined) return problem.message;
      return (
        `${BAND_FIELD_LABELS[lower]} rises to ${round(lowerValue)}% ${when}, ` +
        `above ${BAND_FIELD_LABELS[upper]} at ${round(upperValue)}% — ` +
        `${BAND_FIELD_LABELS[lower]} must stay below ${BAND_FIELD_LABELS[upper]}.`
      );
    }
    default:
      return problem.message;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "at the start" / "3 hours in", matching `scrubber.ts`'s phrasing. */
function describeWhen(atHours: number): string {
  if (!Number.isFinite(atHours) || atHours <= 0) return "at the start of the window";
  if (atHours < 1) {
    const minutes = Math.round(atHours * 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} in`;
  }
  const rounded = Math.round(atHours * 100) / 100;
  return `${rounded} hour${rounded === 1 ? "" : "s"} in`;
}

/**
 * The value each boundary takes at a moment — what the collision panel
 * reads out beside the chart, so a reader can see the two numbers that are
 * the wrong way round rather than infer them.
 */
export function valuesAt(
  window: BudgetWindow,
  atHours: number,
): { readonly key: BandKey; readonly value: number | null }[] {
  return EDIT_BAND_KEYS.map((key) => ({
    key,
    value: boundaryAt(window.boundaries[key], atHours, window.lengthHours),
  }));
}
