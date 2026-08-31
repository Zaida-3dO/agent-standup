// The review card component — MILESTONES.md #68, carrying #69's question.
//
// Hook-free and prop-driven, so it is called as a function and its returned
// element tree inspected — `tests/helpers/react-element.ts`, same technique
// as `tests/since-view-component.test.ts`.
//
// ── What these assertions deliberately do NOT do ───────────────────────
//
// They do not assert on `textContent` for anything the feature is supposed
// to produce. Asserting that some string appears anywhere in the tree has
// been found passing in this repo against static page copy with the feature
// entirely absent. So the sliders are found by element type and their
// `data-facet`, and the Seen button by its own handler identity — things
// only a working implementation puts there.
import { describe, expect, it } from "vitest";
import { ReviewCardView } from "@/components/review/ReviewCardView";
import { reviewRows } from "@/lib/review/card";
import type { FlaggableRun } from "@/lib/review/flagged";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactElement, ReactNode } from "react";

/** Every `input type=range` in the tree — the sliders, and nothing else. */
function sliders(tree: ReactNode): ReactElement[] {
  return findAllByType(tree, "input").filter(
    (el) => (el.props as { type?: string }).type === "range",
  );
}

/** The facet each slider is for, in render order. */
function sliderFacets(tree: ReactNode): (string | undefined)[] {
  return [...walk(tree)]
    .filter((el) => (el.props as { ["data-facet"]?: string })["data-facet"] !== undefined)
    .map((el) => (el.props as { ["data-facet"]?: string })["data-facet"]);
}

/**
 * The Seen button, found by the handler it was given rather than by its
 * text — a label can be typed into static copy, a wired `onClick` cannot.
 */
function seenButton(tree: ReactNode, handler: () => void): ReactElement | undefined {
  return findAllByType(tree, "button").find(
    (el) => (el.props as { onClick?: unknown }).onClick === handler,
  );
}

function acceptButton(tree: ReactNode, handler: (scores: readonly unknown[]) => void) {
  return findAllByType(tree, "button").find((el) => {
    const onClick = (el.props as { onClick?: unknown }).onClick;
    // The accept button wraps its handler, so it is identified by being a
    // button that is not the Seen one and carries a click handler.
    return typeof onClick === "function" && onClick !== handler;
  });
}

const flaggedRun: FlaggableRun = {
  selectionReason: "exploration",
  recommendationStrength: 0.2,
  model: "tier-c",
};

describe("ReviewCardView — only the facets in play", () => {
  it("renders one slider per declared facet and no others", () => {
    const rows = reviewRows({ reasoning: 3, precision: 5 }, [
      { facet: "reasoning", agentScore: 4, userScore: null },
      { facet: "precision", agentScore: 2, userScore: null },
    ]);
    const tree = ReviewCardView({ itemTitle: "A task", rows, personId: "person-a" });

    expect(sliders(tree)).toHaveLength(2);
    // Two facets, and specifically these two — a card with one facet
    // could not prove this.
    expect(sliderFacets(tree)).toEqual(["reasoning", "precision"]);
  });

  it("renders no sliders at all for an item with no facets in play", () => {
    const tree = ReviewCardView({ itemTitle: "A task", rows: [], personId: "person-a" });
    expect(sliders(tree)).toHaveLength(0);
  });
});

describe("ReviewCardView — scoring never blocks Seen", () => {
  // The row's stated invariant, and the mutation most likely to be made
  // against this file: gating Seen on a score being set. Each of these
  // asserts the button is present AND not disabled.
  it("offers Seen with every slider untouched", () => {
    const onMarkSeen = () => {};
    const rows = reviewRows({ reasoning: 3, breadth: 1 }, [
      { facet: "reasoning", agentScore: 4, userScore: null },
      { facet: "breadth", agentScore: 5, userScore: null },
    ]);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      onMarkSeen,
    });

    const button = seenButton(tree, onMarkSeen);
    expect(button).toBeDefined();
    expect((button!.props as { disabled?: boolean }).disabled).toBeFalsy();
  });

  it("offers Seen on a card with no facets to score at all", () => {
    const onMarkSeen = () => {};
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows: [],
      personId: "person-a",
      onMarkSeen,
    });
    expect(seenButton(tree, onMarkSeen)).toBeDefined();
  });

  it("offers Seen on a flagged run, which is an invitation and not a gate", () => {
    const onMarkSeen = () => {};
    const rows = reviewRows({ reasoning: 3 }, [
      { facet: "reasoning", agentScore: 2, userScore: null },
    ]);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      run: flaggedRun,
      onMarkSeen,
    });
    expect(seenButton(tree, onMarkSeen)).toBeDefined();
  });

  it("actually calls the handler when Seen is pressed with nothing scored", () => {
    // Invoking the wired handler proves the button does the thing, rather
    // than merely existing.
    let called = 0;
    const onMarkSeen = () => {
      called += 1;
    };
    const rows = reviewRows({ visual: 4 }, []);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      onMarkSeen,
    });
    const button = seenButton(tree, onMarkSeen);
    (button!.props as { onClick: () => void }).onClick();
    expect(called).toBe(1);
  });

  it("offers no Seen action when no profile is chosen", () => {
    // The one legitimate reason to withhold it: nobody to attribute the
    // read to. Not a score-related reason.
    const onMarkSeen = () => {};
    const rows = reviewRows({ reasoning: 3 }, []);
    const tree = ReviewCardView({ itemTitle: "A task", rows, personId: null, onMarkSeen });
    expect(seenButton(tree, onMarkSeen)).toBeUndefined();
  });
});

describe("ReviewCardView — the sliders carry the person's score apart from the agent's", () => {
  it("marks a slider the person has moved and one they have not", () => {
    const rows = reviewRows({ reasoning: 3, breadth: 3 }, [
      { facet: "reasoning", agentScore: 4, userScore: 2 },
      { facet: "breadth", agentScore: 4, userScore: null },
    ]);
    const tree = ReviewCardView({ itemTitle: "A task", rows, personId: "person-a" });
    const [scored, unscored] = sliders(tree);

    // Same agent score on both, different user state — so this can only
    // pass if the component reads `userScore` rather than `agentScore`.
    expect((scored!.props as Record<string, unknown>)["data-user-scored"]).toBe(true);
    expect((unscored!.props as Record<string, unknown>)["data-user-scored"]).toBe(false);
    expect((scored!.props as { value?: number }).value).toBe(2);
    expect((unscored!.props as { value?: number }).value).toBe(4);
  });

  it("reports a moved slider to its handler with the facet and the new score", () => {
    const moved: [string, number][] = [];
    const rows = reviewRows({ autonomy: 2 }, [
      { facet: "autonomy", agentScore: 3, userScore: null },
    ]);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      onScore: (facet, score) => moved.push([facet, score]),
    });
    const slider = sliders(tree)[0]!;
    (slider.props as { onChange: (e: { target: { value: string } }) => void }).onChange({
      target: { value: "5" },
    });
    expect(moved).toEqual([["autonomy", 5]]);
  });
});

describe("ReviewCardView — the flagged-run question", () => {
  it("shows the cheaper-model question on a flagged run", () => {
    const rows = reviewRows({ reasoning: 3 }, []);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      run: flaggedRun,
    });
    // Read from the paragraph the component builds, not from anywhere in
    // the tree — see the file header on ambient text.
    const texts = [...walk(tree)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c): c is string => typeof c === "string");
    expect(texts.some((t) => t.includes("cheaper model") && t.includes("tier-c"))).toBe(true);
    expect(
      [...walk(tree)].some((el) => (el.props as Record<string, unknown>)["data-flagged"] === true),
    ).toBe(true);
  });

  it("shows no question and no flag on an ordinary confident run", () => {
    const rows = reviewRows({ reasoning: 3 }, []);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      run: { selectionReason: "recommended", recommendationStrength: 0.9, model: "tier-a" },
    });
    const texts = [...walk(tree)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c): c is string => typeof c === "string");
    expect(texts.some((t) => t.includes("up to standard"))).toBe(false);
    expect(
      [...walk(tree)].some((el) => (el.props as Record<string, unknown>)["data-flagged"] === true),
    ).toBe(false);
  });
});

describe("ReviewCardView — accepting the agent's scores", () => {
  it("hands the agent's scores to the accept handler unchanged", () => {
    let received: readonly unknown[] = [];
    const onMarkSeen = () => {};
    const rows = reviewRows({ reasoning: 3, breadth: 4 }, [
      { facet: "reasoning", agentScore: 5, userScore: null },
      { facet: "breadth", agentScore: 2, userScore: null },
    ]);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      onAccept: (scores) => {
        received = scores;
      },
      onMarkSeen,
    });
    const button = acceptButton(tree, onMarkSeen);
    (button!.props as { onClick: () => void }).onClick();
    // Distinct values, so a mutant copying one row's score onto both fails.
    expect(received).toEqual([
      { facet: "reasoning", userScore: 5 },
      { facet: "breadth", userScore: 2 },
    ]);
  });

  it("disables accept when the agent has scored nothing to agree with", () => {
    const onMarkSeen = () => {};
    const rows = reviewRows({ reasoning: 3 }, [
      { facet: "reasoning", agentScore: null, userScore: null },
    ]);
    const tree = ReviewCardView({
      itemTitle: "A task",
      rows,
      personId: "person-a",
      onAccept: () => {},
      onMarkSeen,
    });
    const button = acceptButton(tree, onMarkSeen);
    expect((button!.props as { disabled?: boolean }).disabled).toBe(true);
    // …and Seen is still offered regardless.
    expect(seenButton(tree, onMarkSeen)).toBeDefined();
  });
});
