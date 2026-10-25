// The percentage a progress label shows — one definition, shared by every
// surface that prints a project's progress (the grid card, the Standup
// strip, the project page's state panel), so they cannot disagree.
//
// A leaf: pure arithmetic over a number, no imports, nothing server-side.

/** The largest value shown for "nearly done but not done". */
export const PERCENT_ALMOST_DONE = 99.9;
/** The smallest value shown for "started but barely". */
export const PERCENT_JUST_STARTED = 0.1;

/**
 * Turns a finished/total ratio into the percentage a label prints.
 *
 * Whole numbers, with two exceptions that exist so a label never claims
 * more than is true:
 *
 *   - **100 means every child is closed.** 880 of 882 is not 100%, and
 *     rounding to a whole number says it is.
 *   - **0 means none is.** 1 of 500 is not 0%.
 *
 * When whole-number rounding would land on 100 or 0 while the real ratio is
 * neither, the value gets one decimal place, held to `99.9` / `0.1` so the
 * decimal itself cannot round up to 100.0 or down to 0.0 (1999 of 2000 is
 * `99.9`, not `100.0`; 1 of 5000 is `0.1`, not `0.0`). Every other ratio
 * rounds to a whole number as before.
 *
 * The result is a plain number, so `` `${percent}%` `` prints `99.8%` and
 * `50%` with no trailing `.0`, and it can be used as-is for a CSS width.
 *
 * Takes the ratio already clamped to `0`–`1`.
 */
export function percentOf(ratio: number): number {
  if (ratio >= 1) return 100;
  if (ratio <= 0) return 0;
  const whole = Math.round(ratio * 100);
  if (whole !== 100 && whole !== 0) return whole;
  const tenths = Math.round(ratio * 1000) / 10;
  return Math.min(PERCENT_ALMOST_DONE, Math.max(PERCENT_JUST_STARTED, tenths));
}
