// The three boundary kinds, in plain words — MILESTONES.md #87.
//
// §17.4 tabulates each kind with an example of how it "reads as": a
// constant reads as `80%`, a linear as `15 × days − 5`, a schedule as
// `80, rising to 92 in the final hour`. This module is that column,
// computed — because a boundary a reader cannot say out loud is one they
// cannot check, and the editor's whole job is letting somebody see what
// they have configured without holding the schema in their head.
//
// Pure string-building over the model, with no React: the phrasing is the
// behaviour worth testing, and testing it as data is what makes that
// possible in an environment with no DOM.
import type { Boundary } from "../settings/budget-windows";

/** `15` rather than `15.00`, and `−5` rather than `+-5`. */
function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** The unit, singular or plural to match the count that precedes it. */
function unit(per: "hour" | "day", count: number): string {
  const plural = Math.abs(count) === 1 ? "" : "s";
  return `${per}${plural}`;
}

/**
 * A linear, as arithmetic a reader can follow.
 *
 * Written as the sum it is — rate times elapsed, plus a starting point —
 * with the sign folded into the words rather than left as `+ -5`, because
 * the reader is checking a rule, not parsing an expression.
 */
function describeLinear(slope: number, offset: number, per: "hour" | "day"): string {
  const rate = `${number(slope)}% per ${per}`;
  if (offset === 0) return rate;
  const direction = offset > 0 ? "starting at" : "starting at";
  return `${rate}, ${direction} ${number(offset)}%`;
}

/** Where a schedule entry sits, said from whichever end it was written from. */
export function describeAnchor(at: {
  elapsed?: number;
  remaining?: number;
  per: "hour" | "day";
}): string {
  if (at.elapsed !== undefined) {
    return at.elapsed === 0
      ? "from the start"
      : `after ${number(at.elapsed)} ${unit(at.per, at.elapsed)}`;
  }
  const remaining = at.remaining ?? 0;
  return remaining === 0
    ? "at the very end"
    : `in the final ${number(remaining)} ${unit(at.per, remaining)}`;
}

/**
 * One boundary, in a sentence.
 *
 * A schedule is described entry by entry rather than summarised, because
 * the thing a reader is checking *is* the sequence — a summary that said
 * "three steps" would hide exactly what they came to look at.
 */
export function describeBoundary(boundary: Boundary): string {
  switch (boundary.kind) {
    case "constant":
      return `${number(boundary.value)}%`;
    case "linear":
      return describeLinear(boundary.slope, boundary.offset, boundary.per);
    case "schedule": {
      const parts = boundary.entries.map((entry) => {
        const where = describeAnchor(entry.at);
        const what =
          entry.value.kind === "constant"
            ? `${number(entry.value.value)}%`
            : describeLinear(entry.value.slope, entry.value.offset, entry.value.per);
        return `${what} ${where}`;
      });
      return parts.join(", then ");
    }
  }
}

/** One line explaining what a kind *is*, for a reader meeting it first. */
export const KIND_HELP: Readonly<Record<Boundary["kind"], string>> = Object.freeze({
  constant: "A fixed percentage. The boundary does not move for the whole window.",
  linear:
    "A percentage that moves at a steady rate as the window elapses — a rate, and where it starts.",
  schedule:
    "A sequence of values, each taking effect at a moment in the window. Anchor a step to either end: after so long, or in the final stretch.",
});
