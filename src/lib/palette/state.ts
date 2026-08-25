// Moving the palette's selection — the part `cmdk` would have owned.
//
// Kept as pure functions over (list, index) for the reason given in
// `commands.ts`: this is the behaviour a keyboard-only person depends on
// most, so it is the behaviour that most needs to be tested directly rather
// than through a rendered component in a harness that has no DOM.
import type { Command } from "./commands";

/**
 * Where the selection goes when the list changes under it.
 *
 * Always the first row, never a clamped version of the previous index. Typing a
 * letter re-filters the list, and keeping position 3 would leave the
 * highlight on whatever unrelated command now happens to be third — the
 * person's next Enter would run a command they never looked at. Resetting
 * to the top means the highlight is always on a row the current query
 * produced.
 */
export const FIRST_INDEX = 0;

/**
 * The selection after moving `delta` rows.
 *
 * **Wraps at both ends.** Down from the last row goes to the first. On a
 * list this short, stopping at the end means a person holding the down key
 * silently stops making progress and has to work out why; wrapping is what
 * every palette a person has used already does.
 *
 * An empty list pins the index at 0 rather than producing `NaN` from a
 * modulo by zero — there is nothing to select, and 0 is the index that
 * `selectedCommand` correctly reports nothing for.
 */
export function movedSelection(count: number, index: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * The command at `index`, or `null` when the list cannot supply one.
 *
 * `null` rather than throwing: an Enter pressed against an empty result set
 * is an ordinary thing a person does after typing a query that matches
 * nothing, and it should do nothing at all.
 */
export function selectedCommand(commands: readonly Command[], index: number): Command | null {
  return commands[index] ?? null;
}

/**
 * What a key pressed **inside** the palette means.
 *
 * Separate from `@/lib/palette/keys`, which decides what opens an overlay.
 * Once the palette is open it owns the keyboard entirely, so this is a
 * closed set and everything not in it is typing into the query box.
 */
export type PaletteKeyAction =
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "run" }
  | { readonly kind: "close" }
  | { readonly kind: "pass" };

const PASS: PaletteKeyAction = { kind: "pass" };

/**
 * The palette's own key handling.
 *
 * `Ctrl+n`/`Ctrl+p` are accepted alongside the arrows because this is a
 * tool for someone who "lives in a terminal", where those are the movement
 * keys. Bare `j`/`k` are deliberately **not** accepted here even though the
 * row lists them: the palette's query box is a text field, and claiming
 * two letters would make "jk" unsearchable. `j`/`k` belong to a list view
 * with no text input, which is where the row's `j/k through a list` sits.
 */
export function decidePaletteKey(press: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}): PaletteKeyAction {
  if (press.key === "Escape") return { kind: "close" };
  if (press.key === "Enter") return { kind: "run" };
  if (press.key === "ArrowDown") return { kind: "move", delta: 1 };
  if (press.key === "ArrowUp") return { kind: "move", delta: -1 };
  if (press.ctrlKey === true && press.key.toLowerCase() === "n") return { kind: "move", delta: 1 };
  if (press.ctrlKey === true && press.key.toLowerCase() === "p") return { kind: "move", delta: -1 };
  return PASS;
}
