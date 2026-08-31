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
import { groupProblemRuns } from "@/lib/budget-page/edit";
import { gridStepHours } from "@/lib/settings/budget-windows";
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

  // Contiguous runs of the same fault, so the chart marks stretches rather
  // than samples. The grid step comes from the window being drawn, which is
  // what lets a genuinely healthy gap break a run instead of one long mark
  // spanning a fault that actually cleared in the middle.
  const runs = groupProblemRuns(problems, gridStepHours(window.lengthHours));

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

      {/* Every crossing, marked over the STRETCH it covers rather than once
          per sampled moment.

          `findCrossings` samples the window at `SAMPLE_COUNT` = 101 points
          and reports each faulty sample independently, so a fault that
          holds for the whole window arrives here as 101 problems — up to
          303 with all three faults at once. Drawn as one full-height line
          each, those marks tiled the plot area solid and hid the very chart
          they were annotating: the reader lost the boundaries entirely and
          learned nothing about *where* the fault was, because it was
          everywhere.

          So the runs are collapsed first, with the same `groupProblemRuns`
          the editor already uses for its prose list — one shaded band per
          contiguous fault, which is the honest picture: a fault spanning
          the window reads as a span, and one lasting a moment still reads
          as a moment. Reusing that function rather than restating the
          grouping keeps the drawing and the sentences agreeing about how
          many faults there are. */}
      {runs.map((run, index) => {
        const from = markerX(run.fromHours, window, box);
        const to = markerX(run.toHours, window, box);
        const width = to - from;

        // A run covering a single sampled moment has no width to shade, so
        // it stays a line — otherwise a zero-width rect would render as
        // nothing at all and an isolated fault would go unmarked.
        if (!(width > 0)) {
          return (
            <line
              key={`crossing-${index}-${run.fromHours}`}
              x1={from}
              y1={0}
              x2={from}
              y2={box.height}
              className={styles.crossingMark}
            />
          );
        }

        return (
          <rect
            key={`crossing-${index}-${run.fromHours}-${run.toHours}`}
            x={from}
            y={0}
            width={width}
            height={box.height}
            className={styles.crossingSpan}
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
