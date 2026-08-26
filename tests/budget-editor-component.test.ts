// The budget editor's presentational components — MILESTONES.md #87.
//
// A function component is just a function: calling it returns the element
// tree as a plain object graph, and event-handler props are function
// references that can be invoked directly. That only works for hook-free
// components, which is why every presentational component here is one — see
// `tests/helpers/react-element.ts`.
//
// What is proved here is *what is rendered and what a control does to the
// draft*. Whether pressing Save actually reaches the network is a different
// question, and it needs real React — `tests/budget-editor-wiring.test.ts`.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { findCrossings, type BudgetWindow } from "@/lib/settings/budget-windows";
import { findAllByType, walk } from "./helpers/react-element";
import { BudgetEditorView } from "@/components/budget/BudgetEditorView";
import { WindowEditor } from "@/components/budget/WindowEditor";
import { BoundaryFields } from "@/components/budget/BoundaryFields";
import { BandChart } from "@/components/budget/BandChart";
import {
  boundaryToDraft,
  windowToDraft,
  windowsToDraft,
  type BoundaryDraft,
} from "@/lib/budget-page/edit";

const constant = (value: number) => ({ kind: "constant" as const, value });

function windowWith(overrides: Partial<BudgetWindow> = {}): BudgetWindow {
  return {
    enabled: true,
    lengthHours: 5,
    boundaries: { selective: constant(60), windDown: constant(80), stop: constant(95) },
    ...overrides,
  };
}

/** A window whose wind down sits above stop — a real, named crossing. */
function crossedWindow(): BudgetWindow {
  return windowWith({
    boundaries: { selective: constant(20), windDown: constant(80), stop: constant(40) },
  });
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

function editorProps(overrides: Partial<Parameters<typeof WindowEditor>[0]> = {}) {
  const window = windowWith();
  return {
    name: "weekly",
    draft: windowToDraft(window),
    parsed: window,
    problems: [],
    incompleteness: null,
    onChange: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

describe("WindowEditor — a coherent window", () => {
  it("draws the chart and no collision panel", () => {
    const element = WindowEditor(editorProps());
    expect(findAllByType(element, BandChart)).toHaveLength(1);
    expect(textOf(element)).not.toContain("collide");
  });

  it("offers a form for each of the three boundaries", () => {
    const fields = findAllByType(WindowEditor(editorProps()), BoundaryFields);
    expect(fields.map((f) => (f.props as { band: string }).band)).toEqual([
      "selective",
      "windDown",
      "stop",
    ]);
  });

  it("shows the reason it cannot be saved instead of a blank space where the chart was", () => {
    // A missing chart with no explanation is the worst of both worlds.
    const element = WindowEditor(
      editorProps({ parsed: null, incompleteness: "Give the window a length in hours." }),
    );
    expect(findAllByType(element, BandChart)).toHaveLength(0);
    expect(textOf(element)).toContain("Give the window a length in hours.");
  });
});

describe("WindowEditor — drawing a collision", () => {
  const window = crossedWindow();
  const problems = findCrossings(window);

  it("has real problems to draw, so the rest of this block is not vacuous", () => {
    expect(problems.length).toBeGreaterThan(0);
  });

  it("passes the problems to the chart so they are marked where they happen", () => {
    const element = WindowEditor(editorProps({ parsed: window, problems }));
    const chart = findAllByType(element, BandChart)[0];
    expect((chart?.props as { problems: unknown[] }).problems).toHaveLength(problems.length);
  });

  it("marks the two implicated boundary forms and leaves the innocent one alone", () => {
    // The point of the structured detail: send the reader to the boundary
    // to change, rather than making them work out which of three is at fault.
    const element = WindowEditor(editorProps({ parsed: window, problems }));
    const marked = findAllByType(element, BoundaryFields)
      .filter((f) => (f.props as { implicated: boolean }).implicated)
      .map((f) => (f.props as { band: string }).band);
    expect(marked.sort()).toEqual(["stop", "windDown"]);
  });

  it("names both boundaries and both values in the form's own labels", () => {
    const text = textOf(WindowEditor(editorProps({ parsed: window, problems })));
    expect(text).toContain("Wind down");
    expect(text).toContain("Stop");
    expect(text).toContain("80");
    expect(text).toContain("40");
    // A form that said only "invalid" would tell the reader strictly less
    // than the raw stored value would — that is the acceptance criterion.
    expect(text).not.toMatch(/^\s*invalid\s*$/i);
  });

  it("does not leak the schema's key spelling into a page of labelled fields", () => {
    const text = textOf(WindowEditor(editorProps({ parsed: window, problems })));
    expect(text).not.toContain("windDown");
  });

  it("reads out every boundary's value at the moment of the first collision", () => {
    // So the crossing is checkable rather than asserted.
    const text = textOf(WindowEditor(editorProps({ parsed: window, problems })));
    expect(text).toContain("Every boundary");
    expect(text).toContain("Marked on the chart at");
  });

  it("prints ONE line for a fault that holds all window, not one per sample", () => {
    // The measured defect: 101 near-identical <li>s across 1873px for one
    // time-invariant fact. Asserted on the rendered list, because that is
    // the thing that was long — `groupProblemRuns` being correct in
    // isolation would not have caught the panel failing to call it.
    expect(problems.length).toBe(101);
    const element = WindowEditor(editorProps({ parsed: window, problems }));
    const items = findAllByType(element, "li").filter(
      (li) => typeof (li.props as { children?: unknown }).children === "string",
    );
    const collisionLines = items.filter((li) =>
      String((li.props as { children: string }).children).includes("must stay below"),
    );
    expect(collisionLines).toHaveLength(1);
    expect(String((collisionLines[0]!.props as { children: string }).children)).toContain(
      "for the whole window",
    );
  });

  it("counts the heading in faults, so it does not promise 101 lines above one", () => {
    const text = textOf(WindowEditor(editorProps({ parsed: window, problems })));
    expect(text).not.toContain("101 moments");
    expect(text).toContain("These boundaries collide, and this window cannot be saved");
  });

  it("centres the chart on the first collision rather than on the window's start", () => {
    const shifted = problems.map((problem) => ({ ...problem, atHours: 2 }));
    const element = WindowEditor(editorProps({ parsed: window, problems: shifted }));
    const chart = findAllByType(element, BandChart)[0];
    expect((chart?.props as { atHours: number }).atHours).toBe(2);
  });
});

describe("BoundaryFields — one form per kind", () => {
  function fieldProps(draft: BoundaryDraft, implicated = false) {
    return {
      windowName: "weekly",
      band: "stop" as const,
      label: "Stop",
      draft,
      implicated,
      onChange: vi.fn(),
    };
  }

  it("shows a single percent field for a constant", () => {
    const element = BoundaryFields(fieldProps(boundaryToDraft(constant(90))));
    const ids = findAllByType(element, "input").map((i) => (i.props as { id: string }).id);
    expect(ids).toEqual(["budget-weekly-stop-value"]);
  });

  it("shows a rate, a starting point and a unit for a linear", () => {
    const element = BoundaryFields(
      fieldProps(boundaryToDraft({ kind: "linear", slope: 5, offset: 10, per: "day" })),
    );
    const ids = findAllByType(element, "input").map((i) => (i.props as { id: string }).id);
    expect(ids).toEqual(["budget-weekly-stop-slope", "budget-weekly-stop-offset"]);
    const selects = findAllByType(element, "select").map((s) => (s.props as { id: string }).id);
    expect(selects).toContain("budget-weekly-stop-per");
  });

  it("shows one row per step for a schedule, and a way to add another", () => {
    const element = BoundaryFields(
      fieldProps(
        boundaryToDraft({
          kind: "schedule",
          entries: [
            { at: { elapsed: 0, per: "hour" }, value: constant(60) },
            { at: { remaining: 1, per: "hour" }, value: constant(90) },
          ],
        }),
      ),
    );
    // Asserted structurally rather than by text. `walk` does not *invoke*
    // nested components — a child component appears as an unexpanded
    // element — so the step rows are `EntryFields` elements here, and a
    // text search would be vacuously satisfied by the kind-help sentence
    // that also contains the word "step".
    const steps = [...walk(element)].filter(
      (node) => typeof node.type === "function" && node.type.name === "EntryFields",
    );
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => (step.props as { index: number }).index)).toEqual([0, 1]);
    // Both are removable, since more than one remains.
    expect(steps.every((step) => (step.props as { removable: boolean }).removable)).toBe(true);
    const buttons = findAllByType(element, "button").map((b) =>
      String((b.props as { children?: unknown }).children),
    );
    expect(buttons).toContain("Add a step");
  });

  it("offers no Remove on a schedule's only step, because one is the minimum", () => {
    const one = BoundaryFields(
      fieldProps(
        boundaryToDraft({
          kind: "schedule",
          entries: [{ at: { elapsed: 0, per: "hour" }, value: constant(60) }],
        }),
      ),
    );
    // Structural for the same reason as above — and this is the assertion
    // that would have been *vacuous* as a text search, since "Remove step"
    // is rendered inside the nested component and `textOf` would never have
    // found it whether it was there or not.
    const steps = [...walk(one)].filter(
      (node) => typeof node.type === "function" && node.type.name === "EntryFields",
    );
    expect(steps).toHaveLength(1);
    expect((steps[0]?.props as { removable: boolean }).removable).toBe(false);
  });

  it("marks the whole group rather than one box when it is implicated", () => {
    // A crossing is a fault of this boundary against another; there is no
    // single input that is wrong.
    const element = BoundaryFields(fieldProps(boundaryToDraft(constant(90)), true));
    const fieldset = findAllByType(element, "fieldset")[0];
    expect((fieldset?.props as { "aria-invalid"?: boolean })["aria-invalid"]).toBe(true);
  });

  it("does not claim invalidity when it is not implicated", () => {
    const element = BoundaryFields(fieldProps(boundaryToDraft(constant(90)), false));
    const fieldset = findAllByType(element, "fieldset")[0];
    expect((fieldset?.props as { "aria-invalid"?: boolean })["aria-invalid"]).toBeUndefined();
  });
});

describe("BudgetEditorView — the page", () => {
  function viewProps(overrides: Partial<Parameters<typeof BudgetEditorView>[0]> = {}) {
    const window = windowWith();
    return {
      loadState: { status: "loaded" as const, windows: { weekly: window } },
      draft: windowsToDraft({ weekly: window }),
      parsed: { weekly: window },
      problems: {},
      incompleteness: {},
      blockedReason: null,
      saveState: { status: "idle" as const },
      newName: "",
      addError: null,
      onNewNameChange: vi.fn(),
      onAddWindow: vi.fn(),
      onChangeWindow: vi.fn(),
      onRemoveWindow: vi.fn(),
      onSave: vi.fn(),
      onTakeTheirs: vi.fn(),
      ...overrides,
    };
  }

  it("shows the error rather than an empty page", () => {
    const element = BudgetEditorView(
      viewProps({ loadState: { status: "error", message: "boom" }, draft: null }),
    );
    expect(textOf(element)).toContain("boom");
    expect(findAllByType(element, WindowEditor)).toHaveLength(0);
  });

  it("says it is loading rather than showing nothing", () => {
    const element = BudgetEditorView(viewProps({ loadState: { status: "loading" }, draft: null }));
    expect(textOf(element)).toContain("Loading");
  });

  it("invites a first window rather than showing a bare page when there are none", () => {
    const element = BudgetEditorView(
      viewProps({
        draft: windowsToDraft({}),
        parsed: {},
        loadState: { status: "loaded", windows: {} },
      }),
    );
    expect(textOf(element)).toContain("Add one below");
  });

  it("says WHY save is disabled, beside the button rather than in a tooltip", () => {
    // A disabled control whose reason is hidden is what sends somebody back
    // to editing raw JSON.
    const element = BudgetEditorView(viewProps({ blockedReason: "weekly: fix the collision" }));
    expect(textOf(element)).toContain("weekly: fix the collision");
    const button = findAllByType(element, "button").find((b) =>
      String((b.props as { children?: unknown }).children).includes("Save"),
    );
    expect((button?.props as { disabled: boolean }).disabled).toBe(true);
  });

  it("enables save when nothing is blocking it", () => {
    const element = BudgetEditorView(viewProps({ blockedReason: null }));
    const button = findAllByType(element, "button").find((b) =>
      String((b.props as { children?: unknown }).children).includes("Save"),
    );
    expect((button?.props as { disabled: boolean }).disabled).toBe(false);
  });

  it("announces a refused save as an alert, naming what the other session did", () => {
    const element = BudgetEditorView(
      viewProps({
        saveState: {
          status: "conflict",
          message: 'Somebody else added "nightly" while this page was open.',
          theirs: {},
        },
      }),
    );
    const text = textOf(element);
    expect(text).toContain("somebody else changed this first");
    expect(text).toContain("nightly");
    expect(text).toContain("Discard my changes and load theirs");
    // It appears without the reader having touched the field it concerns,
    // so it is announced rather than merely drawn.
    const alert = [...walk(element)].find(
      (node) => (node.props as { role?: string }).role === "alert",
    );
    expect(alert).toBeDefined();
  });

  it("reports a failed save without pretending it succeeded", () => {
    const element = BudgetEditorView(
      viewProps({ saveState: { status: "error", message: "The write failed (500)." } }),
    );
    expect(textOf(element)).toContain("The write failed (500).");
  });

  it("confirms a save that worked", () => {
    const element = BudgetEditorView(viewProps({ saveState: { status: "saved" } }));
    expect(textOf(element)).toContain("Saved.");
  });

  it("shows the reason a name was refused, next to the field", () => {
    const element = BudgetEditorView(
      viewProps({ addError: 'There is already a window called "weekly".' }),
    );
    expect(textOf(element)).toContain('There is already a window called "weekly".');
  });
});
