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

/** How many points along a window the crossing check evaluates. */
const SAMPLE_COUNT = 101;

function perHours(per: "hour" | "day"): number {
  return per === "hour" ? 1 : 24;
}

/**
 * The value of a boundary at `elapsedHours` into a window `lengthHours` long.
 *
 * A schedule holds until its next entry starts: the entry in force at a
 * moment is the last one whose anchor is at or before it, and before the
 * first entry the first entry's value applies (a schedule that says nothing
 * about the opening minute is not a hole, it is the same rule from the top).
 */
export function boundaryAt(boundary: Boundary, elapsedHours: number, lengthHours: number): number {
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

      // `anchored` is non-empty: the schema requires at least one entry.
      let inForce = anchored[0]!;
      for (const candidate of anchored) {
        if (candidate.startHours <= elapsedHours) inForce = candidate;
      }
      // Nested schedules are unrepresentable, so this recursion is one deep.
      return boundaryAt(inForce.value, elapsedHours, lengthHours);
    }
  }
}

export interface CrossingProblem {
  /** Window key, present when the check ran over a map of windows. */
  window?: string;
  /** Hours into the window at which the problem is first observable. */
  atHours: number;
  message: string;
}

/**
 * Samples a window across its length and reports every moment at which its
 * boundaries cross or leave 0–100.
 *
 * Sampling rather than solving: a schedule is piecewise and the pieces are
 * arbitrary, so there is no closed form to solve. The sample points include
 * every schedule entry's own start, which is where a piecewise function's
 * discontinuities are — an even grid alone could step over a rule that is in
 * force for less than one interval.
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
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        problems.push({
          atHours,
          message: `${key} is ${value} at ${atHours}h, outside 0–100`,
        });
      }
    }

    for (let i = 0; i + 1 < values.length; i += 1) {
      const lower = values[i]!;
      const upper = values[i + 1]!;
      if (lower.value > upper.value) {
        problems.push({
          atHours,
          message: `${lower.key} (${lower.value}) is above ${upper.key} (${upper.value}) at ${atHours}h`,
        });
      }
    }

    // One report per moment is enough to name it; further moments still
    // get their own entry, so a rule that is wrong across the whole window
    // is distinguishable from one wrong at a single point.
    if (problems.length > 0 && problems[problems.length - 1]!.atHours === atHours) continue;
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
