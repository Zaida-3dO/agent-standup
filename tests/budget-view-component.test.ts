// The budget editor's components — MILESTONES.md #87.
//
// A function component is just a function: calling it returns the element
// tree as a plain object graph, and event-handler props are function
// references that can be invoked directly. That only works for hook-free
// components, which is why every presentational component here is one — see
// `tests/helpers/react-element.ts`.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { BudgetWindow } from "@/lib/settings/budget-windows";
import { findAllByType, walk } from "./helpers/react-element";
import { BudgetWindowsView } from "@/components/budget/BudgetWindowsView";
import { WindowCard } from "@/components/budget/WindowCard";
import { BandChart } from "@/components/budget/BandChart";

const constant = (value: number) => ({ kind: "constant" as const, value });

function windowWith(overrides: Partial<BudgetWindow> = {}): BudgetWindow {
  return {
    enabled: true,
    lengthHours: 5,
    boundaries: { selective: constant(60), windDown: constant(80), stop: constant(95) },
    ...overrides,
  };
}

/** Every string in the tree, for "does the page say X" assertions. */
function textOf(root: ReactNode): string {
  let text = "";
  for (const element of walk(root)) {
    const children = (element.props as { children?: ReactNode }).children;
    if (typeof children === "string") text += ` ${children}`;
    else if (Array.isArray(children)) {
      for (const child of children) if (typeof child === "string") text += ` ${child}`;
    }
  }
  return text;
}

function baseProps(overrides: Partial<Parameters<typeof BudgetWindowsView>[0]> = {}) {
  return {
    loadState: { status: "loaded" as const, windows: { main: windowWith() } },
    problems: {},
    scrubbed: {},
    onScrub: vi.fn(),
    ...overrides,
  };
}

describe("BudgetWindowsView — load states", () => {
  it("shows the error rather than an empty page", () => {
    const element = BudgetWindowsView(
      baseProps({ loadState: { status: "error", message: "boom" } }),
    );
    expect(textOf(element)).toContain("boom");
    expect(findAllByType(element, WindowCard)).toHaveLength(0);
  });

  it("says it is loading rather than showing nothing", () => {
    const element = BudgetWindowsView(baseProps({ loadState: { status: "loading" } }));
    expect(textOf(element)).toContain("Loading");
    expect(findAllByType(element, WindowCard)).toHaveLength(0);
  });

  // An installation with no windows is a valid state, not a failure — every
  // setting has a default and this one's is empty.
  it("says plainly when nothing is configured", () => {
    const element = BudgetWindowsView(baseProps({ loadState: { status: "loaded", windows: {} } }));
    expect(textOf(element)).toContain("No budget windows are configured");
    expect(findAllByType(element, WindowCard)).toHaveLength(0);
  });

  it("renders one card per window, in a stable order", () => {
    const element = BudgetWindowsView(
      baseProps({
        loadState: {
          status: "loaded",
          windows: { weekly: windowWith(), fiveHour: windowWith() },
        },
      }),
    );
    const cards = findAllByType(element, WindowCard);
    expect(cards.map((card) => (card.props as { name: string }).name)).toEqual([
      "fiveHour",
      "weekly",
    ]);
  });
});

describe("WindowCard", () => {
  function card(overrides: Partial<Parameters<typeof WindowCard>[0]> = {}): ReactElement {
    return WindowCard({
      name: "main",
      window: windowWith(),
      problems: [],
      atHours: 0,
      onScrub: vi.fn(),
      ...overrides,
    });
  }

  // The three boundary kinds in plain words is the row's own wording, and
  // it is what a reader checks a configuration against.
  it("says every boundary in plain words", () => {
    const text = textOf(card());
    expect(text).toContain("Selective");
    expect(text).toContain("Wind down");
    expect(text).toContain("Stop");
    expect(text).toContain("60%");
    expect(text).toContain("95%");
  });

  it("names the kind of each boundary", () => {
    const text = textOf(
      card({
        window: windowWith({
          boundaries: {
            selective: { kind: "linear", slope: 15, offset: -5, per: "day" },
            windDown: constant(80),
            stop: constant(95),
          },
        }),
      }),
    );
    expect(text).toContain("linear");
    expect(text).toContain("15% per day");
  });

  // A disabled window is still configuration somebody wrote and will come
  // back to, so it is annotated rather than hidden.
  it("says when a window is not enforced, without hiding it", () => {
    const element = card({ window: windowWith({ enabled: false }) });
    expect(textOf(element)).toContain("Not enforced");
    expect(findAllByType(element, BandChart)).toHaveLength(1);
  });

  it("draws a chart for the window", () => {
    const charts = findAllByType(card(), BandChart);
    expect(charts).toHaveLength(1);
    expect((charts[0]?.props as { atHours: number }).atHours).toBe(0);
  });

  // Listed as well as drawn: the list is what a screen reader reaches and
  // what somebody copies into a bug report.
  it("lists every crossing problem when the window is incoherent", () => {
    const text = textOf(
      card({
        problems: [
          { atHours: 3, message: "windDown (50) is above stop (40) at 3h" },
          { atHours: 4, message: "stop is 140 at 4h, outside 0–100" },
        ],
      }),
    );
    expect(text).toContain("2 moments where these boundaries do not hold");
    expect(text).toContain("windDown (50) is above stop (40) at 3h");
    expect(text).toContain("stop is 140 at 4h, outside 0–100");
  });

  it("says one moment in the singular", () => {
    const text = textOf(card({ problems: [{ atHours: 1, message: "stop is 140 at 1h" }] }));
    expect(text).toContain("One moment where these boundaries do not hold");
  });

  it("shows no problem list for a coherent window", () => {
    expect(textOf(card())).not.toContain("do not hold");
  });

  it("reads every boundary out at the scrubbed moment", () => {
    const text = textOf(card({ atHours: 2 }));
    expect(text).toContain("Selective: 60%");
    expect(text).toContain("Stop: 95%");
    expect(text).toContain("2 hours in");
  });

  // The scrubber's range has to span the window, or the reader cannot reach
  // the end of it — which is where most rules do their work.
  it("gives the scrubber the window's own length as its range", () => {
    const [range] = findAllByType(card({ window: windowWith({ lengthHours: 168 }) }), "input");
    expect((range?.props as { max: number }).max).toBe(168);
    expect((range?.props as { min: number }).min).toBe(0);
  });

  it("reports a scrub against the window it belongs to", () => {
    const onScrub = vi.fn();
    const [range] = findAllByType(card({ onScrub }), "input");
    (range?.props as { onChange: (event: unknown) => void }).onChange({
      target: { value: "3.5" },
    });
    expect(onScrub).toHaveBeenCalledWith("main", 3.5);
  });
});

describe("BandChart", () => {
  function chart(overrides: Partial<Parameters<typeof BandChart>[0]> = {}): ReactElement {
    return BandChart({ window: windowWith(), problems: [], atHours: 0, ...overrides });
  }

  it("draws one line per boundary", () => {
    const paths = findAllByType(chart(), "path");
    // Three filled bands and three boundary lines.
    expect(paths.length).toBeGreaterThanOrEqual(6);
    expect(paths.some((path) => (path.props as { d: string }).d.startsWith("M"))).toBe(true);
  });

  // A crossing marked where it happens is the one thing a message cannot
  // do: it puts the fault where the reader is already looking.
  it("marks every crossing at the moment it happens", () => {
    const withProblems = chart({
      window: windowWith({ lengthHours: 10 }),
      problems: [{ atHours: 5, message: "crosses" }],
    });
    const lines = findAllByType(withProblems, "line");
    const xs = lines.map((line) => (line.props as { x1: number }).x1);
    // Half way along a 10h window in a 720-unit box.
    expect(xs).toContain(360);
  });

  it("carries an accessible label naming the window's length", () => {
    const [svg] = findAllByType(chart({ window: windowWith({ lengthHours: 168 }) }), "svg");
    expect((svg?.props as { "aria-label": string })["aria-label"]).toContain("168");
  });
});
