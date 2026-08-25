// The shape of `budget.windows`, and the check that a set of boundaries is
// coherent at every moment of the window rather than only at the moment
// somebody looked. See docs/plans/SCHEMA.md §17.4.
//
// A window carries four bands — free, selective, wind down, stop — so it
// carries three boundaries: where each of the last three begins, in
// percentage points of that window's budget. `free` starts at zero and needs
// no boundary of its own.
import { z } from "zod";

/** A boundary that does not move. */
const constantBoundary = z
  .object({
    kind: z.literal("constant"),
    value: z.number(),
  })
  .strict();

/**
 * A boundary that moves at a fixed rate against elapsed time —
 * `slope × elapsed + offset`, where elapsed is measured in `per` units.
 */
const linearBoundary = z
  .object({
    kind: z.literal("linear"),
    slope: z.number(),
    offset: z.number(),
    per: z.enum(["hour", "day"]),
  })
  .strict();

/**
 * Where a schedule entry sits in the window. Either end is expressible
 * because some rules are naturally written from the start ("by day three")
 * and some from the end ("in the final hour"); both reduce to the same
 * point once the window's length is known.
 */
const scheduleAnchor = z.union([
  z.object({ elapsed: z.number().nonnegative(), per: z.enum(["hour", "day"]) }).strict(),
  z.object({ remaining: z.number().nonnegative(), per: z.enum(["hour", "day"]) }).strict(),
]);

/**
 * A schedule's entries carry a constant or a linear — never another
 * schedule. One level expresses every rule anyone has wanted; the second
 * level is where a shape becomes a language.
 */
const scheduleEntry = z
  .object({
    at: scheduleAnchor,
    value: z.union([constantBoundary, linearBoundary]),
  })
  .strict();

const scheduleBoundary = z
  .object({
    kind: z.literal("schedule"),
    entries: z.array(scheduleEntry).min(1),
  })
  .strict();

export const boundarySchema = z.discriminatedUnion("kind", [
  constantBoundary,
  linearBoundary,
  scheduleBoundary,
]);

export type Boundary = z.infer<typeof boundarySchema>;

/**
 * One window. `length` is what turns a `remaining` anchor and a per-hour
 * slope into a point on the same axis, so it is required rather than
 * inferred: without it "the final hour" has no location.
 */
const windowShape = z
  .object({
    enabled: z.boolean(),
    lengthHours: z.number().positive(),
    boundaries: z
      .object({
        selective: boundarySchema,
        windDown: boundarySchema,
        stop: boundarySchema,
      })
      .strict(),
  })
  .strict();

export type BudgetWindow = z.infer<typeof windowShape>;

const BAND_ORDER = ["selective", "windDown", "stop"] as const;

/**
 * The three boundaries a window carries, named.
 *
 * Exported from the model because `CrossingProblem.detail` names bands and a
 * consumer needs the type to switch on them exhaustively. It is deliberately
 * the *same* three keys as `budget-page/chart.ts`'s `BAND_KEYS`, which stays
 * declared separately there: that one is a drawing order, this one is the
 * model's vocabulary, and the two agreeing is a fact rather than a
 * dependency either should carry.
 */
export type BandKey = (typeof BAND_ORDER)[number];

/** How many points along a window the crossing check evaluates. */
const SAMPLE_COUNT = 101;

function perHours(per: "hour" | "day"): number {
  return per === "hour" ? 1 : 24;
}

/**
 * The value of a boundary at `elapsedHours` into a window `lengthHours` long,
 * or `null` where the boundary has no value at that moment.
 *
 * A schedule holds until its next entry starts: the entry in force at a
 * moment is the last one whose anchor is at or before it, and before the
 * first entry the first entry's value applies (a schedule that says nothing
 * about the opening minute is not a hole, it is the same rule from the top).
 *
 * **Total, rather than assuming its input is already valid.** A schedule
 * with no entries has no value at any moment, and the schema does reject
 * one — but `superRefine` runs even when the shape it is refining failed,
 * so this function is reached with input the schema has already refused.
 * Returning null there is what keeps a malformed write a *rejection*
 * instead of a crash: a validator that throws is a 500 where a 400 was
 * meant, on the one path whose entire job is to say no politely.
 */
export function boundaryAt(
  boundary: Boundary,
  elapsedHours: number,
  lengthHours: number,
): number | null {
  switch (boundary.kind) {
    case "constant":
      return boundary.value;
    case "linear":
      return boundary.slope * (elapsedHours / perHours(boundary.per)) + boundary.offset;
    case "schedule": {
      const anchored = boundary.entries
        .map((entry) => ({
          startHours:
            "elapsed" in entry.at
              ? entry.at.elapsed * perHours(entry.at.per)
              : lengthHours - entry.at.remaining * perHours(entry.at.per),
          value: entry.value,
        }))
        .sort((a, b) => a.startHours - b.startHours);

      let inForce = anchored[0];
      if (!inForce) return null;
      for (const candidate of anchored) {
        if (candidate.startHours <= elapsedHours) inForce = candidate;
      }
      // Nested schedules are unrepresentable, so this recursion is one deep.
      return boundaryAt(inForce.value, elapsedHours, lengthHours);
    }
  }
}

/**
 * What kind of fault a `CrossingProblem` records. Structured alongside the
 * sentence rather than instead of it — see `CrossingProblem.detail`.
 */
export type CrossingDetail =
  | { kind: "missing"; band: BandKey }
  | { kind: "out-of-range"; band: BandKey; value: number }
  | { kind: "mis-ordered"; lower: BandKey; lowerValue: number; upper: BandKey; upperValue: number };

export interface CrossingProblem {
  /** Window key, present when the check ran over a map of windows. */
  window?: string;
  /** Hours into the window at which the problem is first observable. */
  atHours: number;
  message: string;
  /**
   * The same fault as data — which bands, and what their values were.
   *
   * **Why both a sentence and its parts.** The sentence is what a reader
   * copies into a bug report and what a screen reader reaches, so it stays
   * the primary rendering of a fault. But a *drawing*
   * needs to know which two lines collided and at what height, and that
   * cannot be recovered from prose without parsing English. Adding the
   * fields is what lets the editor mark the exact pair on the chart instead
   * of falling back to a generic "invalid" — the thing §17.4's editor is
   * for.
   *
   * Optional because a `CrossingProblem` may be constructed by a caller
   * that only has a sentence; consumers treat its absence as "draw the
   * moment, but not the pair".
   */
  detail?: CrossingDetail;
}

/**
 * Samples a window across its length and reports every moment at which its
 * boundaries cross or leave 0–100.
 *
 * **Why sampling, and why these points.** Sampling rather than solving,
 * because a schedule is piecewise with arbitrary pieces and there is no
 * closed form to solve. The point set is three things unioned, and each
 * earns its place:
 *
 * - **The two endpoints.** Constants and linears are monotonic, so any two
 *   of them cross at most once and can never re-order; a violation between
 *   two monotonic boundaries is therefore still present at an endpoint.
 * - **Every schedule entry's own start.** That is where a piecewise
 *   function jumps, and a jump is invisible to any grid that does not land
 *   on it — an entry in force for less than one grid interval would
 *   otherwise be stepped over entirely.
 * - **An even grid across the length.** The case the first two miss: a
 *   schedule entry holding a *linear*, which moves within its own segment.
 *   Between two switch points that are each fine, its interior can leave
 *   the range or cross another boundary, and only a point inside the
 *   segment sees it.
 *
 * The grid is a bound on how short a violation can be and still be found,
 * not a guarantee: a segment narrower than one interval and violating only
 * strictly between its own switch points can pass. That residual is
 * accepted rather than hidden — closing it needs per-segment interval
 * arithmetic, which is a different and much larger piece of work than the
 * check this section asks for.
 */
export function findCrossings(window: BudgetWindow): CrossingProblem[] {
  const problems: CrossingProblem[] = [];
  const { lengthHours, boundaries } = window;

  const points = new Set<number>();
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    points.add((lengthHours * i) / (SAMPLE_COUNT - 1));
  }
  for (const key of BAND_ORDER) {
    const boundary = boundaries[key];
    if (boundary.kind !== "schedule") continue;
    for (const entry of boundary.entries) {
      const at =
        "elapsed" in entry.at
          ? entry.at.elapsed * perHours(entry.at.per)
          : lengthHours - entry.at.remaining * perHours(entry.at.per);
      if (at >= 0 && at <= lengthHours) points.add(at);
    }
  }

  for (const atHours of [...points].sort((a, b) => a - b)) {
    const values = BAND_ORDER.map((key) => ({
      key,
      value: boundaryAt(boundaries[key], atHours, lengthHours),
    }));

    for (const { key, value } of values) {
      if (value === null) {
        problems.push({
          atHours,
          message: `${key} has no value at ${atHours}h`,
          detail: { kind: "missing", band: key },
        });
      } else if (!Number.isFinite(value) || value < 0 || value > 100) {
        problems.push({
          atHours,
          message: `${key} is ${value} at ${atHours}h, outside 0–100`,
          detail: { kind: "out-of-range", band: key, value },
        });
      }
    }

    // Ordering is only a question where both sides have a value; a
    // boundary reported as missing above is not also reported as
    // mis-ordered against one, which would be two complaints about one
    // fault.
    for (let i = 0; i + 1 < values.length; i += 1) {
      const lower = values[i]!;
      const upper = values[i + 1]!;
      if (lower.value === null || upper.value === null) continue;
      if (lower.value > upper.value) {
        problems.push({
          atHours,
          message: `${lower.key} (${lower.value}) is above ${upper.key} (${upper.value}) at ${atHours}h`,
          detail: {
            kind: "mis-ordered",
            lower: lower.key,
            lowerValue: lower.value,
            upper: upper.key,
            upperValue: upper.value,
          },
        });
      }
    }
  }

  return problems;
}

/**
 * The value type of both `budget.windows` and `accounts.budget_windows`: a
 * map of window name to window. It is the *same* schema in both places —
 * per SCHEMA.md §17.7 an override changes where a value is stored, never
 * what type it is.
 */
export const budgetWindowsSchema = z
  .record(z.string().min(1), windowShape)
  .superRefine((windows, ctx) => {
    for (const [name, window] of Object.entries(windows)) {
      // A refinement runs even when the shape it refines failed to parse,
      // so `window` here is only typed as valid, not known to be. Re-check
      // it and let the shape errors stand alone: a window that is not the
      // right shape yet has no coherent answer to "do its boundaries
      // cross", and reporting both would bury the error that has to be
      // fixed first under one derived from it.
      if (!windowShape.safeParse(window).success) continue;
      for (const problem of findCrossings(window)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `budget window "${name}": ${problem.message}`,
        });
      }
    }
  });

export type BudgetWindows = z.infer<typeof budgetWindowsSchema>;
