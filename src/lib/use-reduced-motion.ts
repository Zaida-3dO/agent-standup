"use client";

// Whether the reader has asked for reduced motion — T6-A.
//
// Most of the board's reduced-motion handling is CSS, and CSS is the right
// place for it: a `@media (prefers-reduced-motion: reduce)` block needs no
// JavaScript and cannot get out of step with the setting. This hook exists
// for the two decisions that are NOT expressible in a stylesheet:
//
//   1. the drag overlay's `transform` is computed in JS and written as an
//      inline style, which a media query cannot override without
//      `!important` games; and
//   2. the drop animation is a library option (`dropAnimation={null}`), not
//      a style at all.
//
// **`useSyncExternalStore`, not `useState` + `useEffect`.** A media query is
// precisely what that hook is for — a value living outside React that can
// change at any time and must be read consistently. The effect-based
// spelling has two defects this avoids: it writes state during an effect
// (a second render pass for a value the subscription already knew), and it
// renders once with a guessed value before correcting itself.
import { useSyncExternalStore } from "react";

/** The query the CSS uses, kept here so the two cannot disagree about the setting they read. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Subscribes to changes of the media query, returning the unsubscribe function React will call. */
function subscribe(onChange: () => void): () => void {
  // Guarded because this also runs where there is no `matchMedia` — a test
  // under `environment: "node"`, or any non-browser host. A board that threw
  // here would be a board that did not render at all.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  // **The subscription matters.** The setting can be changed while the page
  // is open — it is a system-wide accessibility toggle — and a value read
  // only once would keep animating for the rest of the session.
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The current value, read fresh from the browser each time React asks. */
function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * The server's answer.
 *
 * **`false`, and the direction is deliberate.** The server has no media
 * queries, so any value here is a guess; guessing "animate" means the worst
 * case is a single frame of motion before the client corrects it, whereas
 * guessing "reduced" would suppress motion for everyone in the server
 * render. The client's first paint uses `getSnapshot`, so a reader who asked
 * for reduced motion gets it immediately on hydration.
 */
function getServerSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
