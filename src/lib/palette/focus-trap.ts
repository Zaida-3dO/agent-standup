// Trapping focus inside an open overlay — the decision half.
//
// ── Why this is here and not in the dialog ──────────────────────────────
//
// `QuickCreateDialog` is hook-free by design: this repository's harness runs
// with no DOM, so every view under `src/components/` is a plain function
// that a test calls directly (`tests/helpers/react-element.ts`). Trapping
// focus needs `useRef` and `useEffect`, and putting them in the dialog would
// have taken the dialog — and its 71 tests — out of that harness entirely.
//
// **The container is the right owner**, because it is the thing that knows
// the dialog is open and it is where the trigger that opened it lives. What
// is left in the container is the smallest possible amount of DOM work; the
// rule about *which* element Tab should reach is here, as a pure function
// over a list.
//
// This module names DOM types but touches no document and no global: it is
// given the elements and returns which one to focus.

/**
 * The selector for everything that can hold focus in an overlay.
 *
 * `[tabindex="-1"]` is excluded via the `:not`, because an element made
 * programmatically focusable is one a person should not reach by Tab — the
 * dialog's own container is exactly that, and including it would put an
 * invisible stop in the middle of the cycle.
 *
 * `:not([disabled])` matters more than it looks: quick create's submit
 * button is disabled until the draft is valid, and a cycle that included it
 * would send Tab to an element the browser refuses to focus, leaving focus
 * on the body and escaping the trap on the very first press.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Which element Tab should move to, given where focus is now.
 *
 * Returns `null` when the browser's own behaviour is already correct — the
 * ordinary case of tabbing between two fields in the middle of the dialog —
 * so the caller only calls `preventDefault()` on the two presses that
 * actually need redirecting. Overriding every Tab would mean re-implementing
 * the browser's focus order, which is a thing this cannot do better and
 * would get wrong for anything it did not anticipate.
 *
 * The two presses that need it are the ends of the cycle: Tab on the last
 * element wraps to the first, Shift+Tab on the first wraps to the last.
 * Focus sitting outside the list entirely — which happens on the very first
 * Tab if the dialog opened without focusing anything — is pulled back to
 * the first element, which is what makes this a trap rather than a wrap.
 */
export function nextTrapFocus<T>(
  focusable: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;

  const index = active === null ? -1 : focusable.indexOf(active);
  // Focus is somewhere outside the overlay. Whichever direction it was
  // heading, the answer is to be back inside it.
  if (index === -1) return shiftKey ? last : first;

  if (shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}
