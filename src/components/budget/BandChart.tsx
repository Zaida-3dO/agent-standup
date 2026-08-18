// The band chart — MILESTONES.md #87.
//
// Hook-free and prop-driven, same as `BoardView.tsx` and `SettingsView.tsx`:
// with `environment: "node"` and no DOM, a component that takes plain props
// can be called directly as a function and its returned tree inspected,
// which is what actually proves these branches. All the geometry is in
// `@/lib/budget-page/chart`, so what is testable here is *what is drawn*
// rather than where.
//
// Inline SVG rather than a charting library, deliberately: the dependency
// list here is seven packages and a chart library would be the largest
// thing in it, to draw three polylines and four filled regions. Colour
// comes from the stylesheet rather than from attributes, so the chart obeys
// the same palette as everything else on the page.
import { Fragment } from "react";
import type { BudgetWindow, CrossingProblem } from "@/lib/settings/budget-windows";
import { DEFAULT_BOX, markerX, seriesFor, xFor, yFor, type BandKey } from "@/lib/budget-page/chart";
import styles from "./Budget.module.css";

export interface BandChartProps {
  readonly window: BudgetWindow;
  /** Drawn where they happen, as well as listed beneath the card. */
  readonly problems: readonly CrossingProblem[];
  /** Where the scrubber sits, in hours. */
  readonly atHours: number;
}

/**
 * The stroke class per band, so the palette lives in the stylesheet rather
 * than in an attribute here.
 *
 * Inferred rather than annotated `Record<BandKey, string>`: a CSS module's
 * exports are typed as possibly absent, and the annotation would assert
 * they are not. Inference keeps the key set exact without making a claim
 * about a stylesheet this module does not check.
 */
const LINE_CLASS = {
  selective: styles.lineSelective,
  windDown: styles.lineWindDown,
  stop: styles.lineStop,
} satisfies Record<BandKey, string | undefined>;

export function BandChart({ window, problems, atHours }: BandChartProps) {
  const box = DEFAULT_BOX;
  const series = seriesFor(window, box);

  // The bands are the regions *between* the lines, so each is drawn as the
  // area under its own boundary, painted lowest-first. Overlaying rather
  // than computing four disjoint polygons keeps this readable and gives the
  // same picture, because each fill is translucent and the one above covers
  // the one below exactly where it should.
  const areas = series.map((line) => {
    const closed = `${line.path} L${box.width} ${box.height} L0 ${box.height} Z`;
    return { key: line.key, d: line.path === "" ? "" : closed };
  });

  const scrubberX = xFor(atHours, window.lengthHours, box);

  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${box.width} ${box.height}`}
      role="img"
      aria-label={`Budget bands across ${window.lengthHours} hours`}
      preserveAspectRatio="none"
    >
      {/* Painted before the lines so a boundary is never hidden by a fill. */}
      <rect x={0} y={0} width={box.width} height={box.height} className={styles.bandStop} />
      {areas.map((area) => {
        if (area.d === "") return null;
        const className =
          area.key === "selective"
            ? styles.bandFree
            : area.key === "windDown"
              ? styles.bandSelective
              : styles.bandWindDown;
        return <path key={`band-${area.key}`} d={area.d} className={className} />;
      })}

      {series.map((line) => (
        <path
          key={`line-${line.key}`}
          d={line.path}
          className={`${styles.line} ${LINE_CLASS[line.key]}`}
        />
      ))}

      {/* Every crossing, marked at the moment it happens. A message can say
          "at 3h"; only the mark puts it where the reader is looking. */}
      {problems.map((problem, index) => {
        const x = markerX(problem.atHours, window, box);
        return (
          <line
            key={`crossing-${index}-${problem.atHours}`}
            x1={x}
            y1={0}
            x2={x}
            y2={box.height}
            className={styles.crossingMark}
          />
        );
      })}

      <line x1={scrubberX} y1={0} x2={scrubberX} y2={box.height} className={styles.scrubberLine} />

      <Fragment>
        <line x1={0} y1={box.height} x2={box.width} y2={box.height} className={styles.axis} />
        <text x={2} y={yFor(100, box) + 10} className={styles.axisLabel}>
          100%
        </text>
        <text x={2} y={box.height - 3} className={styles.axisLabel}>
          0%
        </text>
        <text x={box.width - 44} y={box.height - 3} className={styles.axisLabel}>
          {`${window.lengthHours}h`}
        </text>
      </Fragment>
    </svg>
  );
}
