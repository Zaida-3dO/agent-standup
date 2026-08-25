// The undo toast's rendered output — T18.
//
// Called as a plain function and its element tree walked
// (`tests/helpers/react-element.ts`), which is what the whole
// `src/components/` tree is kept hook-free for. No DOM, no renderer.
//
// The claim under test: **a button that cannot do anything is worse than
// no button at all**. So the assertions are about the button's *presence*,
// not its enabled-ness — a disabled button would pass a naive "the button
// is not clickable" check while still reading to a person as an offer
// withheld.
import { describe, expect, it } from "vitest";
import { UndoToast } from "@/components/toast/UndoToast";
import { actionOffered, inverseOf, type UndoToastState, type UndoableAction } from "@/lib/undo";
import { findAllByType, walk } from "./helpers/react-element";

const aStateChange: UndoableAction = {
  kind: "state-change",
  at: 1_000,
  move: { itemId: "item-1", from: "executing", to: "in_review" },
  itemTitle: "Wire the thing",
};

const anArchive: UndoableAction = {
  kind: "archive",
  at: 1_000,
  itemId: "item-1",
  itemTitle: "A duplicate",
};

/** Renders the toast the way the host does — plan derived from the action. */
function render(state: UndoToastState, secondsLeft: number | null = 7, onUndo = () => {}) {
  const action = state.phase === "offered" ? state.action : null;
  return UndoToast({
    state,
    plan: action === null ? null : inverseOf(action),
    secondsLeft,
    onUndo,
    onDismiss: () => {},
  });
}

/** Every string of text anywhere in the tree, flattened. */
function textOf(tree: ReturnType<typeof render>): string {
  const parts: string[] = [];
  for (const element of walk(tree)) {
    const children = (element.props as { children?: unknown }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** The undo button, identified by its label rather than by position. */
function undoButtons(tree: ReturnType<typeof render>) {
  return findAllByType(tree, "button").filter((button) => {
    const children = (button.props as { children?: unknown }).children;
    const flat = Array.isArray(children) ? children : [children];
    return flat.some((child) => child === "Undo");
  });
}

describe("an offered, undoable action", () => {
  const tree = render(actionOffered(aStateChange));

  it("renders an undo button", () => {
    expect(undoButtons(tree)).toHaveLength(1);
  });

  it("names what happened, in words rather than state ids", () => {
    const text = textOf(tree);
    expect(text).toContain("Wire the thing");
    // `in_review` is not a phrase — the underscore is replaced.
    expect(text).toContain("in review");
    expect(text).not.toContain("in_review");
  });

  it("shows the countdown, inside the undo button", () => {
    // Asserted on the button's own subtree rather than on flattened page
    // text: the countdown renders as a `<span>` whose children are the
    // number and the unit as separate nodes, so a whole-tree text join
    // separates them and would match even if the number rendered
    // somewhere else entirely.
    const span = findAllByType(undoButtons(tree)[0]!, "span");
    expect(span).toHaveLength(1);
    const children = (span[0]!.props as { children: unknown[] }).children;
    expect(children).toContain(7);
  });

  it("shows no countdown when there is no time to show", () => {
    const noCount = render(actionOffered(aStateChange), null);
    expect(findAllByType(undoButtons(noCount)[0]!, "span")).toHaveLength(0);
  });

  it("calls onUndo when pressed", () => {
    let pressed = 0;
    const withHandler = render(actionOffered(aStateChange), 7, () => {
      pressed += 1;
    });
    const button = undoButtons(withHandler)[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(pressed).toBe(1);
  });
});

describe("an action with no inverse", () => {
  const tree = render(actionOffered(anArchive));

  it("renders NO undo button at all", () => {
    // Absent, not disabled — a button that cannot act should not be
    // drawn at all.
    expect(undoButtons(tree)).toHaveLength(0);
  });

  it("still confirms what happened", () => {
    expect(textOf(tree)).toContain("A duplicate");
  });

  it("explains why it cannot be undone", () => {
    expect(textOf(tree)).toContain("cannot be undone");
  });
});

describe("the other phases", () => {
  it("renders nothing at all when idle", () => {
    // Not an empty container: the toast must occupy no space and trap no
    // clicks when there is nothing to say.
    expect(render({ phase: "idle" })).toBeNull();
  });

  it("offers no undo button while an undo is in flight", () => {
    const tree = render({ phase: "undoing", action: aStateChange }, null);
    expect(undoButtons(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain("Undoing");
  });

  it("offers no undo button once undone", () => {
    const tree = render({ phase: "undone" }, null);
    expect(undoButtons(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain("Undone");
  });

  it("shows a stale conflict's message and marks the phase for styling", () => {
    const tree = render(
      {
        phase: "error",
        kind: "stale",
        message: "Someone else moved this — it is now in merged, so the undo was not applied.",
      },
      null,
    );
    expect(textOf(tree)).toContain("Someone else moved this");
    expect(undoButtons(tree)).toHaveLength(0);
    expect((tree!.props as { "data-phase": string })["data-phase"]).toBe("error");
  });
});

describe("accessibility", () => {
  it("announces as a polite status rather than an interrupting alert", () => {
    const tree = render(actionOffered(aStateChange));
    const props = tree!.props as Record<string, unknown>;
    // `status`, not `alert`: this reports something the person just did.
    expect(props["role"]).toBe("status");
    expect(props["aria-live"]).toBe("polite");
    // Atomic, so a screen reader is not re-reading the ticking countdown.
    expect(props["aria-atomic"]).toBe("true");
  });

  it("gives the dismiss control a label, since it renders as a glyph", () => {
    const tree = render(actionOffered(aStateChange));
    const labelled = findAllByType(tree, "button").filter(
      (button) => (button.props as { "aria-label"?: string })["aria-label"] !== undefined,
    );
    expect(labelled).toHaveLength(1);
    expect((labelled[0]!.props as { "aria-label": string })["aria-label"]).toBe(
      "Dismiss notification",
    );
  });
});
