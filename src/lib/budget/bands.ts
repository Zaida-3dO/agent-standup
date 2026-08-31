// The four budget bands, and which one an account is in right now.
// MILESTONES.md #57; SCHEMA.md §17.4; DECISIONS.md §7.
//
// A window carries three boundaries and therefore four bands. Reading up
// from nothing spent: free below the first, selective between the first and
// the second, wind_down between the second and the third, stop at or above
// the third.
//
// Band three is the one worth having (DECISIONS.md §7): start nothing, get
// in-flight work to a good stopping point — not necessarily finished — and
// write the handoff. Without it a budget limit is a wall hit mid-thought and
// the work is stranded wherever it happened to be, which is what makes
// resuming expensive.
//
// Two rules here, both from DECISIONS.md §7.
//
// "Stricter of the two windows wins." An account is usually inside more than
// one window at once — a 5-hour window and a weekly one — and they disagree.
// The strictest answer governs, because a window saying stop is describing a
// limit genuinely about to be hit, and no other window's optimism makes that
// untrue.
//
// "Boundaries move with time." A boundary is evaluated at the moment it is
// asked about, not the moment it was configured, so the same usage figure
// yields different bands at different points in a window. That is the pace
// line: 40% spent is fine four hours into a week and is not fine forty
// minutes in.
//
// What is deliberately NOT here: any number. Every boundary comes from
// budget.windows, or from an account's override of it, and this module
// contains not one threshold of its own. MILESTONES.md lists "the band
// numbers, beyond the starting values" as a decision still belonging to the
// owner, so the mechanism is what ships and the numbers stay configuration —
// which is what a typed setting is for. An evaluator with a threshold baked
// into it would make that decision by accident and hide it where nobody
// would look.
import { boundaryAt, type BudgetWindow, type BudgetWindows } from "../settings/budget-windows";
import type { UsageReading } from "./reading";

/**
 * The four bands, ordered from least to most restrictive.
 *
 * The order is the type: BAND_SEVERITY indexes it, and "strictest wins" is a
 * max over those indices. Declared once so a fifth band cannot be added
 * without the comparison being updated to account for it.
 */
export const BANDS = ["free", "selective", "wind_down", "stop"] as const;

export type Band = (typeof BANDS)[number];

/** How restrictive each band is. Higher is stricter. */
export const BAND_SEVERITY: Readonly<Record<Band, number>> = {
  free: 0,
  selective: 1,
  wind_down: 2,
  stop: 3,
};

/** Which of two bands governs. */
export function stricter(a: Band, b: Band): Band {
  return BAND_SEVERITY[a] >= BAND_SEVERITY[b] ? a : b;
}

/**
 * Why a window did not produce a band.
 *
 * Every one of these leaves the caller unconstrained rather than guessing,
 * and they are kept apart because they call for different fixes:
 * budget-disabled and window-disabled are deliberate choices, no-windows is
 * an installation that has configured none, and the two reading faults are a
 * machine or a wiring problem. A single "unknown" would collapse a
 * deliberate decision and a broken pipe into the same word.
 */
export type NoBandReason =
  | "budget-disabled"
  | "window-disabled"
  | "no-windows"
  | "reading-stale"
  | "reading-absent"
  | "boundary-undefined";

/** One window's verdict. */
export interface WindowVerdict {
  readonly window: string;
  readonly band: Band;
  /** The three boundary values at the moment asked about, to show the workings. */
  readonly boundaries: { selective: number; windDown: number; stop: number };
  /** The usage figure the band was decided from. */
  readonly usage: number;
  /** How far into the window the evaluation was made. */
  readonly elapsedHours: number;
}

/**
 * The answer for an account: a band, or a stated reason there is none.
 *
 * A union rather than a band with a nullable reason, because "unconstrained
 * because nothing is configured" and "free because plenty of headroom
 * remains" are opposite facts a caller must not conflate. A band field
 * defaulting to free in the absence of information would make a broken usage
 * pipeline look like an account with room to spare, which is the failure
 * that spends a budget without noticing.
 */
export type BandDecision =
  | {
      readonly status: "banded";
      readonly band: Band;
      /** Which window produced the governing band. */
      readonly governing: WindowVerdict;
      /** Every window that produced a verdict, in the order evaluated. */
      readonly verdicts: readonly WindowVerdict[];
    }
  | {
      readonly status: "unbanded";
      readonly reason: NoBandReason;
      readonly verdicts: readonly WindowVerdict[];
    };

/**
 * The band one window puts a usage figure in, at elapsedHours into it.
 *
 * Returns null when a boundary has no value at that moment — a schedule with
 * a hole in it, which the setting's own validator rejects on write but which
 * a value stored before the schema tightened can still be (§17.3). An
 * undefined boundary is not treated as infinitely permissive: it produces no
 * band, and the caller says why.
 */
export function bandFor(
  window: BudgetWindow,
  usage: number,
  elapsedHours: number,
): { band: Band; boundaries: WindowVerdict["boundaries"] } | null {
  const selective = boundaryAt(window.boundaries.selective, elapsedHours, window.lengthHours);
  const windDown = boundaryAt(window.boundaries.windDown, elapsedHours, window.lengthHours);
  const stop = boundaryAt(window.boundaries.stop, elapsedHours, window.lengthHours);
  if (selective === null || windDown === null || stop === null) return null;

  const boundaries = { selective, windDown, stop };
  // Tested from the top down, so a usage figure sitting exactly on a
  // boundary lands in the band that boundary begins — §17.4 defines each
  // boundary as "where each of the last three begins", which makes the
  // comparison inclusive at the lower edge.
  if (usage >= stop) return { band: "stop", boundaries };
  if (usage >= windDown) return { band: "wind_down", boundaries };
  if (usage >= selective) return { band: "selective", boundaries };
  return { band: "free", boundaries };
}

/** What an account looks like to this module. */
export interface AccountBandInput {
  /** The windows in force: the account's override, or the global setting. */
  readonly windows: BudgetWindows;
  /** The usage reading, already resolved for staleness. */
  readonly reading: UsageReading;
  /**
   * How far into each window the account is, keyed by the same window names
   * as windows.
   *
   * Supplied rather than computed here. Where a window starts is a property
   * of the vendor's billing, not of this evaluator: a 5-hour window rolls
   * from first use, a weekly one resets on a fixed day, and a metered
   * account has no window at all. Computing it here would bake one vendor's
   * billing calendar into the band maths, which is the thing accounts.vendor
   * exists to keep out. A window with no elapsed figure is skipped.
   */
  readonly elapsedHours: Readonly<Record<string, number>>;
}

/**
 * The band governing an account: the strictest verdict across its windows.
 *
 * budgetEnabled is a parameter rather than a settings read, for the same
 * reason staleAfterSeconds is one in reading.ts — this module stays pure and
 * the one caller holding a snapshot resolves it.
 */
export function decideBand(input: AccountBandInput, budgetEnabled: boolean): BandDecision {
  // DECISIONS.md §7's master switch. Checked first so switching budgets off
  // is unconditional rather than dependent on a reading arriving.
  if (!budgetEnabled) return { status: "unbanded", reason: "budget-disabled", verdicts: [] };

  const names = Object.keys(input.windows).sort();
  if (names.length === 0) return { status: "unbanded", reason: "no-windows", verdicts: [] };

  const enabled = names.filter((name) => input.windows[name]!.enabled);
  if (enabled.length === 0) return { status: "unbanded", reason: "window-disabled", verdicts: [] };

  // The reading is checked after the configuration, so an installation with
  // budgets switched off is never told its usage pipeline is broken — it is
  // not being asked to have one.
  if (input.reading.status === "absent") {
    return { status: "unbanded", reason: "reading-absent", verdicts: [] };
  }
  if (input.reading.status === "stale") {
    // The whole reason #56 lands before this row. A stale figure is not
    // quietly used: acting on it applies an earlier window's headroom to the
    // current one, and a reading that has stopped arriving usually means the
    // machine reporting it has stopped, which is when usage is least
    // predictable.
    return { status: "unbanded", reason: "reading-stale", verdicts: [] };
  }
  const usage = input.reading.value;

  const verdicts: WindowVerdict[] = [];
  for (const name of enabled) {
    const elapsedHours = input.elapsedHours[name];
    if (elapsedHours === undefined) continue;
    const evaluated = bandFor(input.windows[name]!, usage, elapsedHours);
    if (evaluated === null) continue;
    verdicts.push({
      window: name,
      band: evaluated.band,
      boundaries: evaluated.boundaries,
      usage,
      elapsedHours,
    });
  }

  if (verdicts.length === 0) {
    return { status: "unbanded", reason: "boundary-undefined", verdicts: [] };
  }

  // Strictest wins. Strictly greater than on the fold, so a tie keeps the
  // first window in the sorted order — which makes the governing window
  // deterministic for a caller that shows it, rather than dependent on the
  // iteration order of an object.
  let governing = verdicts[0]!;
  for (const verdict of verdicts) {
    if (BAND_SEVERITY[verdict.band] > BAND_SEVERITY[governing.band]) governing = verdict;
  }

  return { status: "banded", band: governing.band, governing, verdicts };
}
