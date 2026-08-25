// The keyboard shortcut registry — T18's second piece, declared as data.
//
// The row's complaint is that this is "a power-user tool used all day by one
// person who lives in a terminal" with **no keyboard affordances at all**,
// and it pairs that with a second requirement that is easy to drop: `?`
// must list them, because "an undiscoverable shortcut set is worth very
// little".
//
// Those two requirements are why this is a table rather than a `switch` in a
// key handler. A `switch` can be *dispatched* from but it cannot be
// *listed*: the help sheet would be a second hand-maintained copy of the
// same knowledge, and the first shortcut anyone added without updating it
// would be invisible forever. Here the dispatcher and the help sheet read
// the same array, so a shortcut that works is a shortcut that documents
// itself — `tests/palette-shortcuts.test.ts` asserts exactly that, over
// every entry.
//
// React-free and DOM-free on purpose, like `@/lib/nav/routes`: what a
// keystroke *means* is decidable without a browser, so it is decided here
// and tested directly (`vitest.config.ts`: `environment: "node"`).
import { NAV_ROUTES, type NavId } from "@/lib/nav/routes";

/**
 * What pressing a shortcut asks for.
 *
 * A closed union rather than a callback per entry, so the table stays plain
 * data that a test can sweep and the help sheet can render. The container
 * turns an intent into an action; nothing here performs one.
 */
export type ShortcutIntent =
  | { readonly kind: "navigate"; readonly href: string }
  | { readonly kind: "open-palette" }
  | { readonly kind: "open-help" }
  | { readonly kind: "open-create" }
  | { readonly kind: "focus-search" };

/**
 * One shortcut, as the dispatcher matches it and the help sheet prints it.
 *
 * `keys` is the full press — one element for a single key (`?`), two for a
 * prefixed pair (`g` then `b`) or a chord (`Ctrl/⌘` `K`). Modelling a pair
 * as two elements rather than as a `gb` string is what lets the dispatcher
 * show the pending prefix while it waits for the second key, and lets the
 * help sheet render the two keys as two separate `<kbd>` elements.
 */
export interface Shortcut {
  readonly id: string;
  readonly keys: readonly string[];
  /**
   * How the keys combine — pressed one after another, or held together.
   *
   * **Stated rather than inferred from `keys.length`.** Two entries carry
   * two keys and mean opposite things: `g` `b` is a sequence, `Ctrl/⌘` `K`
   * is a chord. A dispatcher reading the length would make the palette
   * reachable as `g` then `K`, which is not a sequence anyone presses on
   * purpose, and the help sheet would print the two identically. This field
   * keeps them apart, and `tests/palette-shortcuts.test.ts` sweeps the
   * whole table on it.
   */
  readonly press: "sequence" | "chord";
  /** What the person is doing, phrased as the outcome rather than the mechanism. */
  readonly label: string;
  /** The help sheet's grouping heading. */
  readonly group: "Navigate" | "Act" | "Help";
  readonly intent: ShortcutIntent;
}

/** The prefix key that begins a two-key navigation sequence. */
export const NAV_PREFIX = "g";

/**
 * Which nav destination each `g`-prefixed second key goes to.
 *
 * Keyed by the destination's `NavId` so the href is never written twice:
 * `navShortcutsFor` looks the real route up in `NAV_ROUTES`, which means a
 * destination that moves takes its shortcut with it. A hand-copied href
 * here would be the classic second source of truth that silently rots — the
 * shortcut would keep working and go to a 404.
 *
 * Only five of the eight destinations get a letter, matching the row's
 * `g h/b/p/n/f`. That is a deliberate subset: the remaining three are
 * reachable from the palette and the sidebar, and spending the whole
 * alphabet on navigation leaves nothing for verbs.
 */
export const NAV_SHORTCUT_KEYS: Readonly<Record<string, NavId>> = {
  h: "standup",
  b: "board",
  p: "projects",
  n: "needs-you",
  f: "fleet",
};

/**
 * The `g`-prefixed navigation shortcuts for a given route map.
 *
 * Built rather than written out, so the navigation half cannot drift from
 * `NAV_ROUTES`. A key naming a destination that does not exist is skipped
 * rather than emitted pointing nowhere — `tests/palette-shortcuts.test.ts`
 * checks that every entry's href is a real route.
 */
export function navShortcutsFor(
  routes: readonly { id: NavId; label: string; href: string }[],
): readonly Shortcut[] {
  const navShortcuts: Shortcut[] = [];
  for (const [key, id] of Object.entries(NAV_SHORTCUT_KEYS)) {
    const route = routes.find((candidate) => candidate.id === id);
    if (route === undefined) continue;
    navShortcuts.push({
      id: `nav-${id}`,
      keys: [NAV_PREFIX, key],
      press: "sequence",
      label: `Go to ${route.label}`,
      group: "Navigate",
      intent: { kind: "navigate", href: route.href },
    });
  }
  return Object.freeze(navShortcuts);
}

/**
 * The verbs, which exist regardless of what the route map holds.
 *
 * Kept apart from the navigation half because they are derived from
 * nothing: a route map with no entries still has a create verb and a help
 * sheet. Folding them together would make "what does an empty route map
 * produce?" a question with no answer, and that is the question that proves
 * the navigation half is really derived rather than hand-written.
 */
export function verbShortcuts(): readonly Shortcut[] {
  return Object.freeze([
    {
      id: "palette",
      // Spelled with the platform-neutral name. `KeyboardEvent.key` for the
      // Command key press is `"Meta"`, and the help sheet renders this
      // string as-is, so it says the thing a person recognises on either
      // platform rather than a Mac-only glyph.
      keys: ["Ctrl/⌘", "K"],
      // The one chord in the table. `press` is what stops the dispatcher
      // treating this as a `g`-style sequence — see `Shortcut.press`.
      press: "chord",
      label: "Open the command palette",
      group: "Act",
      intent: { kind: "open-palette" },
    },
    {
      id: "create",
      keys: ["c"],
      press: "sequence",
      label: "Create an item",
      group: "Act",
      intent: { kind: "open-create" },
    },
    {
      id: "search",
      keys: ["/"],
      press: "sequence",
      label: "Search items",
      group: "Act",
      intent: { kind: "focus-search" },
    },
    {
      id: "help",
      keys: ["?"],
      press: "sequence",
      label: "Show keyboard shortcuts",
      group: "Help",
      intent: { kind: "open-help" },
    },
  ]);
}

/** Every shortcut against the app's real route map, in help-sheet order. */
export const SHORTCUTS: readonly Shortcut[] = Object.freeze([
  ...navShortcutsFor(NAV_ROUTES),
  ...verbShortcuts(),
]);

/** The help sheet's group headings, in the order it renders them. */
export const SHORTCUT_GROUPS: readonly Shortcut["group"][] = ["Navigate", "Act", "Help"];

/** The shortcuts in one group, in registry order. */
export function shortcutsInGroup(
  group: Shortcut["group"],
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): readonly Shortcut[] {
  return shortcuts.filter((shortcut) => shortcut.group === group);
}
