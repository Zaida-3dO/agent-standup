// The time scrubber — MILESTONES.md #87.
//
// A window's boundaries move with the clock, so the one question a static
// picture cannot answer is *where are the bands at a given moment*. The
// scrubber is that: a position in the window, and the boundary values
// there, read out in words.
//
// Every transition is a pure function over a position, following
// `board/drag-state.ts`: React holds the value and these decide what it
// becomes. That is what makes the behaviour testable without a DOM, and it
// keeps "what does moving the scrubber do" answerable by reading one small
// module rather than by tracing an event handler.
import { boundaryAt, type BudgetWindow } from "../settings/budget-windows";
import { BAND_KEYS, BAND_LABELS, type BandKey } from "./chart";

/** Where the scrubber sits, in hours from the window's start. */
export interface ScrubberState {
  readonly atHours: number;
}

/** A scrubber starts at the window's beginning — the state a reader assumes. */
export function initialScrubber(): ScrubberState {
  return { atHours: 0 };
}

/**
 * Moves the scrubber, clamped into the window.
 *
 * Clamped rather than refused: a drag that runs past the end is an ordinary
 * gesture, and stopping at the end is what the reader means by it. A
 * non-finite input is treated as no movement, because the alternative is a
 * chart that silently stops drawing.
 */
export function scrubbedTo(
  state: ScrubberState,
  atHours: number,
  lengthHours: number,
): ScrubberState {
  if (!Number.isFinite(atHours)) return state;
  const clamped = Math.min(Math.max(atHours, 0), Math.max(lengthHours, 0));
  return clamped === state.atHours ? state : { atHours: clamped };
}

/** Moves the scrubber by a fraction of the window — what a click on the track means. */
export function scrubbedToFraction(
  state: ScrubberState,
  fraction: number,
  lengthHours: number,
): ScrubberState {
  if (!Number.isFinite(fraction)) return state;
  return scrubbedTo(state, fraction * lengthHours, lengthHours);
}

/** One boundary's value at the scrubbed moment, as the panel reads it out. */
export interface ReadingAtMoment {
  readonly key: BandKey;
  readonly label: string;
  /** `null` where the boundary has no value there — reported, not defaulted to zero. */
  readonly value: number | null;
}

/**
 * What every boundary is at the scrubbed moment.
 *
 * `null` is carried through rather than turned into a number, for the same
 * reason the chart draws a gap: a schedule whose first entry starts later
 * has genuinely nothing to say before it, and printing `0%` there would be
 * a claim the configuration does not make.
 */
export function readingsAt(window: BudgetWindow, atHours: number): ReadingAtMoment[] {
  return BAND_KEYS.map((key) => ({
    key,
    label: BAND_LABELS[key],
    value: boundaryAt(window.boundaries[key], atHours, window.lengthHours),
  }));
}

/**
 * The moment, said the way a reader would say it.
 *
 * Hours below one are given in minutes because "0.25h into the window" is
 * arithmetic and "15 minutes in" is a time.
 */
export function describeMoment(atHours: number): string {
  if (!Number.isFinite(atHours) || atHours <= 0) return "at the start";
  if (atHours < 1) {
    const minutes = Math.round(atHours * 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} in`;
  }
  const rounded = Math.round(atHours * 100) / 100;
  return `${rounded} hour${rounded === 1 ? "" : "s"} in`;
}
