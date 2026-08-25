// The palette's and the help sheet's rendered output.
//
// Called as plain functions and their element trees walked
// (`tests/helpers/react-element.ts`), which is what the whole
// `src/components/` tree is kept hook-free for. No DOM, no renderer — and
// it is why the palette is written rather than taken from `cmdk`, which
// owns its own state and could not be exercised this way.
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ShortcutHelp } from "@/components/palette/ShortcutHelp";
import { SHORTCUTS } from "@/lib/palette/shortcuts";
import type { Command } from "@/lib/palette/commands";
import { walk } from "./helpers/react-element";

const commands: readonly Command[] = [
  {
    id: "go-board",
    label: "Go to Board",
    group: "Go to",
    intent: { kind: "navigate", href: "/board" },
  },
  { id: "create", label: "Create an item", group: "Actions", intent: { kind: "create" } },
  {
    id: "state-merged",
    label: "Change state to merged",
    group: "Change state",
    intent: { kind: "change-state", to: "merged" },
  },
];

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  return CommandPalette({
    commands,
    query: "",
    selectedIndex: 0,
    itemLabel: null,
    errorMessage: null,
    onQueryChange: () => {},
    onSelect: () => {},
    onRun: () => {},
    onClose: () => {},
    onKeyDown: () => {},
    ...overrides,
  });
}

/** Every element carrying the given prop value, anywhere in the tree. */
function elementsWithProp(tree: ReactNode, prop: string, value: unknown): ReactElement[] {
  return [...walk(tree)].filter((el) => (el.props as Record<string, unknown>)[prop] === value);
}

/** Every string of text anywhere in the tree, flattened. */
function textOf(tree: ReactNode): string {
  const parts: string[] = [];
  for (const element of walk(tree)) {
    const children = (element.props as { children?: unknown }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

describe("CommandPalette", () => {
  it("renders one option per command", () => {
    const options = elementsWithProp(renderPalette(), "role", "option");
    expect(options).toHaveLength(commands.length);
  });

  it("marks exactly one option selected, and it is the one at selectedIndex", () => {
    const tree = renderPalette({ selectedIndex: 1 });
    const options = elementsWithProp(tree, "role", "option");
    const selected = options.filter(
      (el) => (el.props as { "aria-selected"?: boolean })["aria-selected"] === true,
    );
    expect(selected).toHaveLength(1);
    // Matched by id rather than by position in the walk, so the assertion
    // still names the right row if the tree's shape changes.
    expect((selected[0]?.props as { id?: string }).id).toBe("palette-option-1");
  });

  it("points aria-activedescendant at the selected option's id", () => {
    // The listbox pattern: focus stays in the input, so this attribute is
    // the ONLY thing that tells a screen reader which row Enter will run.
    const tree = renderPalette({ selectedIndex: 2 });
    const combobox = elementsWithProp(tree, "role", "combobox")[0];
    expect((combobox?.props as { "aria-activedescendant"?: string })["aria-activedescendant"]).toBe(
      "palette-option-2",
    );
  });

  it("omits aria-activedescendant when there is no option to point at", () => {
    // Pointing at a non-existent id is worse than omitting it: a reader is
    // told an option is active and finds nothing there.
    const tree = renderPalette({ commands: [], query: "zzz" });
    const combobox = elementsWithProp(tree, "role", "combobox")[0];
    expect(
      (combobox?.props as { "aria-activedescendant"?: string })["aria-activedescendant"],
    ).toBeUndefined();
  });

  it("names the empty result set with the query that produced it", () => {
    const text = textOf(renderPalette({ commands: [], query: "zzz" }));
    expect(text).toContain("zzz");
    // The rows really are gone, not merely hidden.
    expect(
      elementsWithProp(renderPalette({ commands: [], query: "zzz" }), "role", "option"),
    ).toHaveLength(0);
  });

  it("prints a group heading once per group, not once per row", () => {
    const withTwoInAGroup: readonly Command[] = [
      commands[0]!,
      {
        id: "go-fleet",
        label: "Go to Fleet",
        group: "Go to",
        intent: { kind: "navigate", href: "/fleet" },
      },
      commands[1]!,
    ];
    const tree = renderPalette({ commands: withTwoInAGroup });
    const headings = elementsWithProp(tree, "role", "presentation");
    // Two groups across three rows.
    expect(headings).toHaveLength(2);
    expect(headings.map((el) => (el.props as { children?: unknown }).children)).toEqual([
      "Go to",
      "Actions",
    ]);
  });

  it("names the item the state verbs will act on", () => {
    // Without this the palette offers "Change state to merged" with no
    // statement of what will be merged — an irreversible-shaped action
    // taken on trust.
    const text = textOf(renderPalette({ itemLabel: "Wire the thing" }));
    expect(text).toContain("Wire the thing");
  });

  it("says nothing about an item when there is none in context", () => {
    const text = textOf(renderPalette({ itemLabel: null }));
    expect(text).not.toContain("Acting on");
  });

  it("shows a refusal as an alert", () => {
    const tree = renderPalette({ errorMessage: "Someone else moved this." });
    const alerts = elementsWithProp(tree, "role", "alert");
    expect(alerts).toHaveLength(1);
    expect(textOf(tree)).toContain("Someone else moved this.");
  });

  it("runs the command that was clicked, not the one that is selected", () => {
    // A handler wired to the selected index instead of the row would pass a
    // test that only clicked the first row.
    const ran: string[] = [];
    const tree = renderPalette({ selectedIndex: 0, onRun: (command) => ran.push(command.id) });
    const options = elementsWithProp(tree, "role", "option");
    const onClick = (options[2]?.props as { onClick?: () => void }).onClick;
    onClick?.();
    expect(ran).toEqual(["state-merged"]);
  });

  it("closes on a backdrop click but not on a click inside the panel", () => {
    let closed = 0;
    const tree = renderPalette({ onClose: () => (closed += 1) });
    const backdrop = [...walk(tree)][0]!;
    const onClick = (backdrop.props as { onClick?: (e: unknown) => void }).onClick;

    const backdropNode = {};
    onClick?.({ target: backdropNode, currentTarget: backdropNode });
    expect(closed).toBe(1);

    // A click that started inside the panel and drifted out must not close
    // a palette mid-interaction.
    onClick?.({ target: {}, currentTarget: backdropNode });
    expect(closed).toBe(1);
  });

  it("keeps focus in the input by leaving every option out of the tab order", () => {
    const options = elementsWithProp(renderPalette(), "role", "option");
    for (const option of options) {
      expect((option.props as { tabIndex?: number }).tabIndex).toBe(-1);
    }
  });
});

describe("ShortcutHelp", () => {
  it("lists every registered shortcut", () => {
    // The property the registry exists for. A sheet with its own table
    // would drift the first time a shortcut was added.
    const text = textOf(ShortcutHelp({ onClose: () => {}, onKeyDown: () => {} }));
    for (const shortcut of SHORTCUTS) {
      expect(text, `"${shortcut.label}" is not listed in the help sheet`).toContain(shortcut.label);
    }
  });

  it("prints every key of a multi-key sequence, as separate keys", () => {
    const tree = ShortcutHelp({ onClose: () => {}, onKeyDown: () => {} });
    const kbds = [...walk(tree)].filter((el) => el.type === "kbd");
    const printed = kbds.map((el) => (el.props as { children?: unknown }).children);
    // `g` then `b` — a sequence rendered as the single string "gb" would
    // fail this, and so would one that printed only the second key.
    expect(printed).toContain("g");
    expect(printed).toContain("b");
    // One `<kbd>` per key across the whole registry.
    const totalKeys = SHORTCUTS.reduce((sum, shortcut) => sum + shortcut.keys.length, 0);
    expect(kbds).toHaveLength(totalKeys);
  });

  it("renders a section per non-empty group, and none for an empty one", () => {
    const tree = ShortcutHelp({
      onClose: () => {},
      onKeyDown: () => {},
      shortcuts: [
        {
          id: "only",
          keys: ["x"],
          press: "sequence",
          label: "Do the thing",
          group: "Act",
          intent: { kind: "open-help" },
        },
      ],
    });
    const sections = [...walk(tree)].filter((el) => el.type === "section");
    // Only "Act" has an entry; "Navigate" and "Help" render nothing rather
    // than an empty heading.
    expect(sections).toHaveLength(1);
    expect(textOf(tree)).toContain("Do the thing");
    expect(textOf(tree)).not.toContain("Navigate");
  });

  it("offers a close control with an accessible name", () => {
    const tree = ShortcutHelp({ onClose: () => {}, onKeyDown: () => {} });
    const close = elementsWithProp(tree, "aria-label", "Close keyboard shortcuts");
    expect(close).toHaveLength(1);
  });

  it("closes when the close control is pressed", () => {
    let closed = 0;
    const tree = ShortcutHelp({ onClose: () => (closed += 1), onKeyDown: () => {} });
    const close = elementsWithProp(tree, "aria-label", "Close keyboard shortcuts")[0];
    (close?.props as { onClick?: () => void }).onClick?.();
    expect(closed).toBe(1);
  });
});
