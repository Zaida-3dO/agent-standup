// What a keystroke means — the half of the shortcut handler that is a
// decision rather than a DOM listener.
//
// The container attaches one `keydown` listener and asks this module what
// the press amounts to. Everything that could get a shortcut wrong lives
// here as a pure function over a plain description of the event, so it is
// tested directly in a harness with no DOM (`vitest.config.ts`:
// `environment: "node"`) rather than through a simulated key press.
//
// ── The pending prefix is state, so it is passed in and returned ────────
//
// `g` then `b` is two events, and the first one has to be remembered. That
// memory is the container's `useState`, but the *rule* — what a press does
// given what is pending — is here, which is what makes "g then an unmapped
// key clears the prefix rather than doing something else" a checked fact.
import { NAV_PREFIX, SHORTCUTS, type Shortcut, type ShortcutIntent } from "./shortcuts";

/**
 * The parts of a `KeyboardEvent` a shortcut decision depends on.
 *
 * A structural subset rather than the event itself, so a test constructs
 * one as an object literal and no DOM type is needed to describe a press.
 * `KeyboardEvent` satisfies this shape, so the container passes the real
 * event straight in.
 */
export interface KeyPress {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * Where the press landed, as far as the shortcut rule cares.
 *
 * Deliberately not the element: the only questions are "is the person
 * typing" and "is a modal already open", and reducing the DOM to those two
 * booleans at the edge keeps this module DOM-free while leaving the
 * container with a single, obvious job.
 */
export interface KeyContext {
  /**
   * True when focus is in a text field or a `contenteditable` region.
   *
   * **This is the whole reason single-letter shortcuts are safe.** `c`,
   * `/` and `?` are also ordinary characters, so firing them while someone
   * is typing a title would eat the keystroke and open a dialog mid-word.
   * Every single-key shortcut is suppressed while this is true; `Ctrl/⌘K`
   * is not, because a modified press is not a character and is the one
   * shortcut a person expects to work from anywhere.
   */
  readonly typing: boolean;
  /**
   * True when the palette, the help sheet or the create dialog is open.
   *
   * An open overlay owns the keyboard: `j`/`k` inside the palette move its
   * selection and must not also navigate the page behind it.
   */
  readonly overlayOpen: boolean;
}

/**
 * What the container should do about a press.
 *
 * `pendingPrefix` is returned on every outcome rather than only when it
 * changes, so the caller assigns it unconditionally and cannot leave a
 * stale `g` armed by forgetting a branch.
 */
export interface KeyDecision {
  /** The shortcut to run, or `null` for a press that is not a shortcut. */
  readonly intent: ShortcutIntent | null;
  /** The prefix now waiting for a second key, or `null` for none. */
  readonly pendingPrefix: string | null;
  /**
   * Whether the container should call `preventDefault()`.
   *
   * True for a press this module consumed — including arming the prefix and
   * including `Ctrl/⌘K`, whose browser default (a focus jump to the address
   * bar in some browsers) is exactly what must not happen. False for
   * everything else, so ordinary typing and every unclaimed browser
   * shortcut are untouched.
   */
  readonly handled: boolean;
}

/** Nothing happened: no intent, no prefix, and the press passes through. */
const IGNORED: KeyDecision = { intent: null, pendingPrefix: null, handled: false };

/** True for the palette's own `Ctrl+K` / `⌘K`. */
export function isPaletteChord(press: KeyPress): boolean {
  // Lower-cased because a press with Shift held reports `"K"`, and a person
  // holding all three should still get the palette rather than nothing.
  return press.key.toLowerCase() === "k" && (press.ctrlKey === true || press.metaKey === true);
}

/**
 * What a press means, given what is pending and where it landed.
 *
 * `alt` is treated as a disqualifier for the single-key shortcuts along
 * with `ctrl`/`meta`: `Alt+c` is an OS-level or browser-level chord on
 * every platform this runs on, and claiming it would break something the
 * person did not ask this app about.
 */
export function decideKey(
  press: KeyPress,
  pendingPrefix: string | null,
  context: KeyContext,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): KeyDecision {
  // Checked before every other rule, including before `typing`. The palette
  // chord is the one shortcut that must work from inside a text field —
  // it is how a person who is halfway through typing reaches a verb — and
  // it cannot be confused with a character because it carries a modifier.
  if (isPaletteChord(press)) {
    return { intent: { kind: "open-palette" }, pendingPrefix: null, handled: true };
  }

  // An open overlay owns the keyboard, and a person typing is typing. Both
  // also clear any armed prefix: a `g` followed by a click into a field and
  // then a `b` is not a person asking to navigate, and firing then would be
  // the shortcut acting on a stale intention.
  if (context.overlayOpen || context.typing) return IGNORED;

  // A modified press that is not the palette chord belongs to the browser
  // or the OS. Checked before the prefix table so `Ctrl+P` cannot be
  // swallowed as the "go to projects" second key.
  if (press.ctrlKey === true || press.metaKey === true || press.altKey === true) return IGNORED;

  if (pendingPrefix === NAV_PREFIX) {
    const second = press.key.toLowerCase();
    // Matched on `press`, never on `keys.length`. The palette chord also
    // has two keys and would otherwise be reachable as `g` then `K`, which
    // is not a sequence anyone has ever pressed on purpose.
    const shortcut = shortcuts.find(
      (candidate) => candidate.press === "sequence" && candidate.keys[1] === second,
    );
    // Either way the prefix is spent. An unmapped second key is a typo, not
    // a longer sequence to keep waiting on — leaving `g` armed would make
    // the *next* unrelated keystroke navigate.
    if (shortcut === undefined) return { intent: null, pendingPrefix: null, handled: false };
    return { intent: shortcut.intent, pendingPrefix: null, handled: true };
  }

  if (press.key === NAV_PREFIX) {
    return { intent: null, pendingPrefix: NAV_PREFIX, handled: true };
  }

  // Matched on the key as typed, not lower-cased: `?` is Shift+/ and `/` is
  // not, so folding case here would make the two indistinguishable and the
  // help sheet would open on a search.
  const shortcut = shortcuts.find(
    (candidate) =>
      candidate.press === "sequence" &&
      candidate.keys.length === 1 &&
      candidate.keys[0] === press.key,
  );
  if (shortcut === undefined) return IGNORED;
  return { intent: shortcut.intent, pendingPrefix: null, handled: true };
}
