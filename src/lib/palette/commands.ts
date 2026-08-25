// The command palette's contents and its matching rule — T18's first piece.
//
// The row asks for one entry point covering: navigate to any page · search
// items · create an item · apply a filter · change an item's state · jump to
// a project or an agent. What is here is the list and how a query narrows
// it; performing a command is the container's job.
//
// ── Why the commands are data and the palette is not a library ──────────
//
// The row names `cmdk`. This does not use it, and the reason is this
// repository's harness rather than a dislike of the library: every view
// under `src/components/` is hook-free so it can be called as a plain
// function with no DOM (`tests/helpers/react-element.ts`), and a
// third-party component that owns its own selection state cannot be
// exercised that way at all. Adopting it would have meant the palette —
// the most keyboard-dependent surface in the product — became the one
// surface with no direct tests over its filtering and its selection
// movement. The list below and `@/lib/palette/state` are what `cmdk` would
// have owned, and they are covered directly instead.
import { ITEM_STATES, type ItemStateValue } from "@/lib/service/state-machine/states";
import { NAV_ROUTES } from "@/lib/nav/routes";

/**
 * What running a command asks for.
 *
 * `change-state` carries the state to move to and nothing else: the item
 * and — critically — the state it is moving *from* are the container's to
 * supply, because only it knows which item the page shows. See
 * `stateChangeRequest` for why the `from` is not optional.
 */
export type CommandIntent =
  | { readonly kind: "navigate"; readonly href: string }
  | { readonly kind: "create" }
  | { readonly kind: "help" }
  | { readonly kind: "change-state"; readonly to: ItemStateValue };

/** One row in the palette. */
export interface Command {
  readonly id: string;
  /** What the row reads as — the verb first, so scanning the list reads as a list of actions. */
  readonly label: string;
  /** The grouping heading this row renders under. */
  readonly group: "Go to" | "Actions" | "Change state";
  /**
   * Extra words a query may match that are not in the label.
   *
   * The point is synonyms a person plausibly types — "new" for create,
   * "home" for the standup page — so the palette answers the word they
   * reached for rather than only the word it happens to print.
   */
  readonly keywords?: readonly string[];
  readonly intent: CommandIntent;
}

/** How a state's `snake_case` value reads to a person. */
export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

/**
 * Every command available when no item is in context.
 *
 * The navigation half is built from `NAV_ROUTES` for the same reason the
 * `g`-shortcuts are: a destination that moves takes its palette entry with
 * it, and a hand-written href here would rot into a row that navigates to a
 * 404 while still looking correct.
 */
export function baseCommands(): readonly Command[] {
  return [
    ...NAV_ROUTES.map<Command>((route) => ({
      id: `go-${route.id}`,
      label: `Go to ${route.label}`,
      group: "Go to",
      keywords: route.id === "standup" ? ["home"] : undefined,
      intent: { kind: "navigate", href: route.href },
    })),
    {
      id: "create",
      label: "Create an item",
      group: "Actions",
      keywords: ["new", "add", "mint"],
      intent: { kind: "create" },
    },
    {
      id: "help",
      label: "Show keyboard shortcuts",
      group: "Actions",
      keywords: ["?", "keys", "help"],
      intent: { kind: "help" },
    },
  ];
}

/**
 * The state-change rows, offered only when an item is in context.
 *
 * **Every state is offered, including the one the item is already in.** The
 * state machine permits any state to any state — that is what the row calls
 * out as making undo honest here — but a move to the current state is a
 * no-op that would still write an event, so the current one is excluded.
 * That exclusion is the only filtering done: which moves are *sensible* is
 * a judgement the person makes, and a palette that hid `cancelled` behind a
 * rule about what usually follows `executing` would be second-guessing the
 * one operation the product allows unconditionally.
 */
export function stateCommands(currentState: string | null): readonly Command[] {
  return ITEM_STATES.filter((state) => state !== currentState).map<Command>((state) => ({
    id: `state-${state}`,
    label: `Change state to ${stateLabel(state)}`,
    group: "Change state",
    keywords: ["move", "transition", state],
    intent: { kind: "change-state", to: state },
  }));
}

/**
 * The whole palette for a given context.
 *
 * `itemId` being null is the ordinary case — the palette on a board or a
 * list page — and it simply offers no state rows, because "change state" is
 * meaningless without naming which item.
 */
export function commandsFor(context: {
  readonly itemId: string | null;
  readonly itemState: string | null;
}): readonly Command[] {
  if (context.itemId === null) return baseCommands();
  return [...baseCommands(), ...stateCommands(context.itemState)];
}

/**
 * The commands matching `query`, in registry order.
 *
 * Substring rather than fuzzy, matched case-insensitively across the label
 * and the keywords. Fuzzy matching is what `cmdk` would have brought and it
 * is genuinely nicer on a long list; on a list this size it mostly buys the
 * ability to type `gtb` for "Go to Board", at the cost of a ranking
 * function whose output no test can state a stable expectation about. An
 * empty query returns everything, which is what makes the palette browsable
 * rather than only searchable.
 */
export function matchCommands(commands: readonly Command[], query: string): readonly Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return commands;
  return commands.filter((command) => {
    if (command.label.toLowerCase().includes(needle)) return true;
    return (command.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle));
  });
}

/**
 * The body for a state change the palette performs.
 *
 * **`expectedFrom` is required, and this is the reason the function
 * exists.** `transition_item` gained the precondition in MILESTONES.md
 * #257, and its own doc is explicit that omitting it is not a weaker
 * version of supplying it — it is last-writer-wins. The palette's "change
 * state" verb is the accessible alternative to dragging a card, so it is
 * doing exactly what a drag does, from a page that was rendered at some
 * earlier moment, against a board many agents write concurrently. Without
 * the precondition, a palette move made against a stale page silently
 * overwrites whatever happened in between — the same clobber
 * `@/lib/undo/request` documents at length and refuses to allow.
 *
 * Typed to take a non-optional `from`, so a caller cannot build a request
 * that omits it.
 */
export function stateChangeRequest(
  to: ItemStateValue,
  from: string,
): { readonly to: ItemStateValue; readonly expectedFrom: string } {
  return { to, expectedFrom: from };
}
