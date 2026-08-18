// The band chart's geometry — MILESTONES.md #87, SCHEMA.md §17.4.
//
// Pure functions returning numbers and path strings, with no React and no
// DOM. That is the same split every other page here uses (`board/state.ts`,
// `settings-page/model.ts`) and it exists for a concrete reason: the test
// environment is `node` with no DOM, so geometry proved as data is geometry
// actually proved. A path string assembled inside a component can only be
// checked by rendering, which this repository cannot do.
//
// **What the chart draws.** A window carries four bands — free, selective,
// wind down, stop — separated by three boundaries, each a percentage of the
// window's budget that may move with the clock. So the picture is three
// lines across the window's length, and the bands are the regions between
// them: free from zero up to `selective`, and `stop` from its boundary up
// to 100.
//
// **Values are sampled, not solved.** A schedule is piecewise with
// arbitrary pieces, so there is no closed form — the same reason
// `findCrossings` samples. The sample points here are the plotting grid
// only; correctness of the *boundaries* is `findCrossings`'s question, and
// this module deliberately does not repeat that judgement.
import { boundaryAt, type BudgetWindow } from "../settings/budget-windows";

/**
 * The three boundaries, lowest first.
 *
 * Declared here rather than imported because this module's need is a
 * *drawing* order — which line sits below which, and therefore which band
 * is filled between them — and the model's internal ordering is a
 * comparison order for the crossing check. The two agreeing is a fact about
 * the vocabulary rather than a dependency either should carry.
 */
export const BAND_KEYS = ["selective", "windDown", "stop"] as const;

export type BandKey = (typeof BAND_KEYS)[number];

/** What a reader should see, rather than the key's spelling. */
export const BAND_LABELS: Readonly<Record<BandKey, string>> = Object.freeze({
  selective: "Selective",
  windDown: "Wind down",
  stop: "Stop",
});

/** The plotting box, in user units. Percentages run 0–100 up the y axis. */
export interface ChartBox {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_BOX: ChartBox = Object.freeze({ width: 720, height: 240 });

/** How many points across the window a line is drawn with. */
export const SAMPLE_COUNT = 101;

/** One sampled boundary, ready to draw. */
export interface BoundarySeries {
  readonly key: BandKey;
  readonly label: string;
  /** `null` where the boundary has no value at that moment — a gap, not a zero. */
  readonly points: readonly (readonly [number, number])[];
  /** The `d` of a polyline through the points, with gaps breaking the line. */
  readonly path: string;
}

/**
 * Hours at each sample, including both endpoints and every schedule switch.
 *
 * The switch points matter for the same reason they do in the crossing
 * check: a piecewise function jumps there, and a grid that does not land on
 * a jump draws a straight line through it — which would render a step as a
 * ramp and misinform the reader about what the boundary does.
 */
export function samplePoints(window: BudgetWindow): number[] {
  const { lengthHours, boundaries } = window;
  const points = new Set<number>();
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    points.add((lengthHours * index) / (SAMPLE_COUNT - 1));
  }
  for (const key of BAND_KEYS) {
    const boundary = boundaries[key];
    if (boundary.kind !== "schedule") continue;
    for (const entry of boundary.entries) {
      const at =
        "elapsed" in entry.at
          ? entry.at.elapsed * hoursPer(entry.at.per)
          : lengthHours - entry.at.remaining * hoursPer(entry.at.per);
      if (at >= 0 && at <= lengthHours) points.add(at);
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** Hours in one `per` unit. Local, for the same reason `BAND_KEYS` is. */
function hoursPer(per: "hour" | "day"): number {
  return per === "hour" ? 1 : 24;
}

/** Maps hours into the box's x axis. */
export function xFor(hours: number, lengthHours: number, box: ChartBox = DEFAULT_BOX): number {
  if (lengthHours <= 0) return 0;
  return (hours / lengthHours) * box.width;
}

/**
 * Maps a percentage into the box's y axis.
 *
 * Inverted, because a percentage grows upward and an SVG's y grows
 * downward — so 100% is at y=0. Clamped, because a boundary outside 0–100
 * is a validation error the chart still has to draw *somewhere*: dropping
 * it would hide the very fault the reader is being shown.
 */
export function yFor(percent: number, box: ChartBox = DEFAULT_BOX): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return box.height - (clamped / 100) * box.height;
}

/**
 * Builds a polyline `d`, breaking it wherever a boundary has no value.
 *
 * A gap is drawn as a gap rather than joined across, because joining would
 * assert a value the boundary does not have — a schedule whose first entry
 * starts late genuinely has nothing to say before it.
 */
export function pathFrom(points: readonly (readonly [number, number])[]): string {
  let path = "";
  let penDown = false;
  for (const point of points) {
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      penDown = false;
      continue;
    }
    path += `${penDown ? "L" : "M"}${round(x)} ${round(y)} `;
    penDown = true;
  }
  return path.trim();
}

/** Two decimals is under a tenth of a pixel at this size, and keeps the DOM small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every boundary, sampled and turned into a drawable series.
 *
 * A boundary with no value at a sample contributes a non-finite point,
 * which `pathFrom` renders as a break — so the series carries the gap
 * rather than the caller having to know about it.
 */
export function seriesFor(window: BudgetWindow, box: ChartBox = DEFAULT_BOX): BoundarySeries[] {
  const hours = samplePoints(window);
  return BAND_KEYS.map((key) => {
    const points = hours.map((atHours) => {
      const value = boundaryAt(window.boundaries[key], atHours, window.lengthHours);
      const x = xFor(atHours, window.lengthHours, box);
      const y = value === null || !Number.isFinite(value) ? Number.NaN : yFor(value, box);
      return [x, y] as const;
    });
    return { key, label: BAND_LABELS[key], points, path: pathFrom(points) };
  });
}

/** Where a crossing problem sits on the x axis, so it can be marked on the chart. */
export function markerX(
  atHours: number,
  window: BudgetWindow,
  box: ChartBox = DEFAULT_BOX,
): number {
  return xFor(atHours, window.lengthHours, box);
}
