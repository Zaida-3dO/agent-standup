// The shared state components — `@/components/states`.
//
// Hook-free and prop-driven (see each component's header), so they are called
// directly as functions and their returned element trees inspected — the same
// technique as `tests/board-view-component.test.ts`.
//
// **What would make this file hollow.** Asserting that each component renders
// *something* proves nothing — three components that all rendered an empty
// div would pass. What is asserted instead is the property each one exists
// for: that the three empty kinds produce visibly different output (the whole
// of #123), that the error state carries the failing call's name through
// verbatim rather than reducing it to a generic sentence, and that the
// loading state draws placeholders in the shape of the content.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { walk } from "./helpers/react-element";

/** Every string of text anywhere in the tree, flattened. */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** The `data-state` marker of the outermost element — how a region says which state it is in. */
function stateMarkerOf(root: ReactNode): string | undefined {
  for (const el of walk(root)) {
    const marker = (el.props as { "data-state"?: string })["data-state"];
    if (marker !== undefined) return marker;
  }
  return undefined;
}

/** Every button in the tree. */
function buttonsOf(root: ReactNode) {
  return [...walk(root)].filter((el) => el.type === "button");
}

describe("EmptyState", () => {
  it("renders the three kinds so that no two are the same", () => {
    // The literal statement of #123's principle, generalised: an empty state
    // and a hidden state must not render identically — and neither may be
    // confused with a filter that excluded everything.
    const empty = EmptyState({ kind: "empty", noun: "item", total: 0 });
    const withheld = EmptyState({ kind: "withheld", noun: "item", total: 175 });
    const filtered = EmptyState({ kind: "filtered", noun: "item", total: 12 });

    const markers = [stateMarkerOf(empty), stateMarkerOf(withheld), stateMarkerOf(filtered)];
    expect(markers).toEqual(["empty", "withheld", "filtered"]);
    // Different markers alone would satisfy a machine but not a reader, so
    // the visible text must differ too.
    const texts = [textOf(empty), textOf(withheld), textOf(filtered)];
    expect(new Set(texts).size).toBe(3);
  });

  it("says out loud how many rows a withheld region is holding back", () => {
    // The number is what makes the state honest rather than merely
    // non-empty: "175 items, not loaded" is actionable, "not loaded" barely
    // more useful than showing empty.
    expect(textOf(EmptyState({ kind: "withheld", noun: "item", total: 175 }))).toContain("175");
  });

  it("does not put a count in the genuinely-empty state", () => {
    // Zero is not information, and a "0 items" label next to "nothing here"
    // is the kind of noise that trains a reader to stop reading these.
    expect(textOf(EmptyState({ kind: "empty", noun: "item", total: 0 }))).not.toContain("0");
  });

  it("offers to clear the filter only on the filtered state", () => {
    const clear = () => {};
    expect(
      buttonsOf(EmptyState({ kind: "filtered", total: 12, onClearFilter: clear })).length,
    ).toBe(1);
    // The other two are not the reader's to fix, so neither offers the
    // control even when the handler is supplied.
    expect(buttonsOf(EmptyState({ kind: "empty", total: 0, onClearFilter: clear })).length).toBe(0);
    expect(
      buttonsOf(EmptyState({ kind: "withheld", total: 40, onClearFilter: clear })).length,
    ).toBe(0);
  });

  it("invokes the clear-filter handler when its control is pressed", () => {
    let cleared = 0;
    const element = EmptyState({
      kind: "filtered",
      total: 12,
      onClearFilter: () => {
        cleared++;
      },
    });
    const button = buttonsOf(element)[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(cleared).toBe(1);
  });

  it("offers to load a withheld region when the caller can fetch it", () => {
    let loaded = 0;
    const element = EmptyState({
      kind: "withheld",
      total: 40,
      onLoad: () => {
        loaded++;
      },
    });
    const button = buttonsOf(element)[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(loaded).toBe(1);
  });

  it("only reports, with no control, when the caller gave no handler", () => {
    // A button that cannot do anything is worse than no button.
    expect(buttonsOf(EmptyState({ kind: "withheld", total: 40 })).length).toBe(0);
    expect(buttonsOf(EmptyState({ kind: "filtered", total: 12 })).length).toBe(0);
  });

  it("names what the region holds, so one component serves every region", () => {
    // The reuse property: the same component says "profiles" on the people
    // list and "items" on a board column, without either writing a sentence.
    expect(textOf(EmptyState({ kind: "empty", noun: "profile" }))).toContain("profiles");
    expect(textOf(EmptyState({ kind: "empty", noun: "event" }))).toContain("events");
  });

  it("lets a region override the caption entirely when it needs its own words", () => {
    expect(textOf(EmptyState({ kind: "empty", title: "No one is on call" }))).toContain(
      "No one is on call",
    );
  });
});

describe("ErrorState", () => {
  it("shows the message verbatim, so the failing call survives to the reader", () => {
    // The standard: "Could not load profiles (GET /api/people returned 500)".
    // A component that summarised or replaced this would turn every failure
    // in the product into the same unactionable sentence.
    const message = "Could not load the board (GET /api/board returned 500).";
    expect(textOf(ErrorState({ message }))).toContain(message);
  });

  it("renders the failing call on its own line when given separately", () => {
    const element = ErrorState({ message: "Could not load the board.", call: "GET /api/board" });
    expect(textOf(element)).toContain("GET /api/board");
  });

  it("announces itself, because a failed read changes nothing else on the page", () => {
    const element = ErrorState({ message: "Could not load the board." });
    const alerts = [...walk(element)].filter(
      (el) => (el.props as { role?: string }).role === "alert",
    );
    expect(alerts.length).toBe(1);
  });

  it("offers a retry that calls back, and none when the caller cannot retry", () => {
    let retried = 0;
    const withRetry = ErrorState({
      message: "Could not load the board.",
      onRetry: () => {
        retried++;
      },
    });
    const button = buttonsOf(withRetry)[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(retried).toBe(1);
    expect(buttonsOf(ErrorState({ message: "Could not load the board." })).length).toBe(0);
  });

  it("disables the retry while one is already in flight", () => {
    // Otherwise a reader presses it repeatedly against a slow endpoint and
    // queues up requests whose results race each other.
    const element = ErrorState({ message: "x", onRetry: () => {}, retrying: true });
    const button = buttonsOf(element)[0]!;
    expect((button.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe("LoadingState", () => {
  it("draws one placeholder per row asked for", () => {
    const element = LoadingState({ rows: 5 });
    const items = [...walk(element)].filter((el) => el.type === "li");
    expect(items.length).toBe(5);
  });

  it("draws placeholders rather than a spinner", () => {
    // The distinction the row is about: a skeleton occupies the space the
    // content will occupy. A component rendering one element regardless of
    // `rows` would be a spinner wearing a skeleton's name.
    const three = [...walk(LoadingState({ rows: 3 }))].filter((el) => el.type === "li").length;
    const eight = [...walk(LoadingState({ rows: 8 }))].filter((el) => el.type === "li").length;
    expect(three).toBe(3);
    expect(eight).toBe(8);
  });

  it("marks itself busy and says what is loading", () => {
    const element = LoadingState({ rows: 2, label: "Backlog column" });
    const root = [...walk(element)][0]!;
    expect((root.props as { "aria-busy"?: string })["aria-busy"]).toBe("true");
    expect((root.props as { "aria-label"?: string })["aria-label"]).toContain("Backlog column");
  });
});
