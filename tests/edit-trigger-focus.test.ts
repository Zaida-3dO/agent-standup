// @vitest-environment jsdom
//
// `EditTrigger` — the button that opens an in-place editor and takes focus
// back when that editor closes.
//
// It was extracted from three call sites (`ItemDetailView`'s title,
// `StatusBlock`'s priority and area) so it could own a `useRef`/`useEffect`
// pair without making those components hook-ful; they are called as plain
// functions by this repo's DOM-free harness, and a hook in them throws
// "Invalid hook call" the moment a test calls them.
//
// **That extraction moved an assertion, and this file is where it landed.**
// `tests/item-detail-component.test.ts` and
// `tests/item-detail-status-block.test.ts` walk an element tree and match
// an `EditTrigger` where the trigger sits, so neither can see the tag it
// renders. That the tag is a real `<button>` — Tab-reachable, activated by
// both Enter and Space — is an accessibility property something has to
// pin, and this file is what pins it, on the component that renders the
// element.
//
// Mounted in jsdom rather than called as a function, for the same reason
// the extraction happened at all: this component has hooks.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditTrigger, type EditTriggerProps } from "@/components/item-detail/EditTrigger";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(overrides: Partial<EditTriggerProps> = {}): Promise<HTMLButtonElement> {
  const props: EditTriggerProps = {
    field: "priority",
    label: "Priority: P2 — activate to edit",
    onActivate: () => {},
    variant: "affordance",
    children: createElement("span", null, "P2"),
    ...overrides,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(EditTrigger, props)));
  });
  const button = container.querySelector("button");
  if (!button) throw new Error("EditTrigger rendered no button at all");
  return button;
}

describe("EditTrigger", () => {
  it("renders a real <button>, so Tab reaches it and both Enter and Space activate it", async () => {
    // A `<div onClick>` satisfies neither and looks identical on screen.
    const button = await render();
    expect(button.tagName).toBe("BUTTON");
    // `type="button"`, not the default `submit`: inside a form this would
    // otherwise submit it rather than opening the editor.
    expect(button.getAttribute("type")).toBe("button");
  });

  it("carries the accessible name it was given, saying what activating it edits", async () => {
    // The affordance variant renders an icon and no text at all, so the
    // accessible name is the only thing a screen-reader user has. A bare
    // value ("P2") would not say what the value IS.
    const button = await render();
    expect(button.getAttribute("aria-label")).toBe("Priority: P2 — activate to edit");
  });

  it("renders its children inside the button, so the value stays visible", async () => {
    const button = await render({ children: createElement("span", null, "the area") });
    expect(button.textContent).toContain("the area");
  });

  it("uses the value treatment for a field whose value IS the control, and the pencil for one whose value is a link", async () => {
    // Two looks, one component: the title and headline wrap their value in
    // the button, while priority and area keep a separate pencil because
    // the value is already a link and one element cannot carry two primary
    // actions. A single class for both would give the title a stray pencil
    // box or the priority chip a value treatment it cannot use.
    const asAffordance = (await render({ variant: "affordance" })).className;
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    const asValue = (await render({ variant: "value" })).className;

    expect(asValue).not.toBe("");
    expect(asAffordance).not.toBe("");
    expect(asValue).not.toBe(asAffordance);
  });

  it("takes focus when the field it names is the one whose edit just ended", async () => {
    // The mechanism the whole fix rests on: the trigger focuses ITSELF on
    // remount, because it does not exist while its own editor is open and
    // so cannot be focused by anything holding a reference to it.
    const button = await render({ returnFocusTo: "priority" });
    expect(document.activeElement).toBe(button);
  });

  it("does not take focus when a DIFFERENT field's edit ended", async () => {
    // Four triggers share one edit slot. Without this check, closing the
    // area editor would pull focus to whichever trigger rendered first.
    const button = await render({ field: "priority", returnFocusTo: "area" });
    expect(document.activeElement).not.toBe(button);
  });

  it("does not take focus when no edit has ended at all", async () => {
    // The ordinary case — a page that has never been edited must not steal
    // focus from wherever the reader put it.
    const button = await render({ returnFocusTo: null });
    expect(document.activeElement).not.toBe(button);
  });

  it("clears the return signal after taking focus, so it fires once", async () => {
    // Left set, the effect re-runs on every later re-render and drags focus
    // back here from wherever the reader has since moved it.
    let cleared = 0;
    await render({ returnFocusTo: "priority", onFocusReturned: () => (cleared += 1) });
    expect(cleared).toBeGreaterThan(0);
  });
});
