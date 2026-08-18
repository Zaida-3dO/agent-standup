// The TypeScript side of the design system: which token a value maps to,
// and — for states — which SHAPE stands in for the colour.
//
// The colours themselves live in `src/app/globals.css`; this file only
// names them. That split is deliberate: a component that hardcoded
// `oklch(...)` would be back where the CSS modules started, and a CSS file
// cannot express "every `ItemState` has a triplet" as something a type
// checker enforces. Here, `STATE_ICONS` is a `Record<ItemState, …>`, so
// adding a thirteenth state to `ItemState` fails the build in this file
// until someone decides what it looks like — which is the whole reason to
// centralise it.

import type { ItemState } from "@/lib/board/types";

/**
 * Every `ItemState`, in board order (SCHEMA.md §1.1).
 *
 * Not derived from the type — a type is erased at runtime — so this is the
 * runtime list, and the `Record<ItemState, …>` maps below are what keeps it
 * honest against the type.
 */
export const ITEM_STATES = [
  "someday",
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
  "paused",
  "blocked",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
] as const satisfies readonly ItemState[];

/**
 * The shape that carries a state's meaning when its colour cannot.
 *
 * ── Why this exists at all ────────────────────────────────────────────
 *
 * WCAG 1.4.1: colour may not be the only visual means of conveying
 * information. The usual mitigation is a text label, and every chip in this
 * system has one — but the requirement bites hardest exactly where the
 * label is squeezed out (a dense list, a mini-board, a card at 200px), and
 * "we'll always have room for the word" is not a guarantee anyone can keep.
 *
 * It bites unusually hard in THIS product because red and green here are
 * not "bad" and "good" in a decorative sense — `blocked` demands action and
 * `merged` is finished. A reader with deuteranopia reading hue alone does
 * not lose a nuance, they invert the board. The shape is therefore the
 * primary channel and the colour is reinforcement, not the other way round.
 *
 * Shapes are picked to be distinguishable in SILHOUETTE at 12px, which
 * rules out most icon-set semantics: `circle` vs `circle-dot` is a
 * difference no one sees at that size. Each entry below is one of a small
 * set of genuinely different outlines.
 */
export type StateShape =
  | "dot" /* ○ — nothing is happening */
  | "dot-filled" /* ● — queued, ready */
  | "pencil" /* ✎ — being written */
  | "eye" /* ◉ — under someone's review */
  | "play" /* ▶ — running now */
  | "pause" /* ‖ — deliberately stopped */
  | "alert" /* △ — needs action */
  | "check" /* ✓ — finished well */
  | "book" /* ▤ — finished as knowledge */
  | "slash"; /* ⊘ — closed without doing */

/**
 * State → shape.
 *
 * `paused` (pause bars) and `blocked` (alert triangle) get maximally
 * different outlines on purpose: they share a column (SCHEMA.md §1.1) and
 * the schema names *colour* as what separates them, so this is precisely
 * the pair a colour-blind reader would lose. Amber-vs-red is a hard
 * discrimination for the most common deficiency; two bars against a
 * triangle is not.
 *
 * `wont_do` and `cancelled` deliberately SHARE the slash: they are the same
 * outcome from the reader's point of view (closed, nothing was built), and
 * inventing a distinct shape would imply a distinction the chip's label
 * already carries where it matters.
 */
export const STATE_SHAPES: Record<ItemState, StateShape> = {
  someday: "dot",
  on_deck: "dot-filled",
  planning: "pencil",
  plan_review: "eye",
  executing: "play",
  in_review: "eye",
  paused: "pause",
  blocked: "alert",
  merged: "check",
  research_done: "book",
  wont_do: "slash",
  cancelled: "slash",
};

/**
 * The human label for a state — what the chip actually says.
 *
 * Written out rather than derived from the enum key by a string transform,
 * because two of them do not survive one: `on_deck` should read "On deck"
 * and `wont_do` needs its apostrophe. A derived label would be right ten
 * times and subtly wrong twice, which is the worst ratio for something a
 * reader trusts at a glance.
 */
export const STATE_LABELS: Record<ItemState, string> = {
  someday: "Someday",
  on_deck: "On deck",
  planning: "Planning",
  plan_review: "Plan review",
  executing: "Executing",
  in_review: "In review",
  paused: "Paused",
  blocked: "Blocked",
  merged: "Merged",
  research_done: "Research done",
  wont_do: "Won't do",
  cancelled: "Cancelled",
};

/** The three CSS custom-property names a state chip paints from. */
export interface TokenTriplet {
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
}

/**
 * State → the triplet's custom-property names.
 *
 * Built by template rather than written out twelve times: the naming
 * convention in `globals.css` is `--state-<state>-<role>`, and a hand-typed
 * copy of it here is a second place for a typo to hide — one that fails
 * silently, because an undefined custom property renders as *nothing* and
 * the chip simply loses its colour rather than erroring.
 */
export function stateTokens(state: ItemState): TokenTriplet {
  return {
    fg: `var(--state-${state}-fg)`,
    bg: `var(--state-${state}-bg)`,
    border: `var(--state-${state}-border)`,
  };
}

/** The four priority levels, most urgent first. */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type Priority = (typeof PRIORITIES)[number];

/** Priority → the triplet's custom-property names. Lower-cased to match §4. */
export function priorityTokens(priority: Priority): TokenTriplet {
  const key = priority.toLowerCase();
  return {
    fg: `var(--priority-${key}-fg)`,
    bg: `var(--priority-${key}-bg)`,
    border: `var(--priority-${key}-border)`,
  };
}

/**
 * The four staleness bands — see `globals.css` §6 for why the first one
 * renders nothing.
 */
export type StalenessLevel = "fresh" | "aging" | "stale" | "abandoned";

/** Band boundaries in milliseconds. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Which band an age falls in.
 *
 * Boundaries are `>=`, so exactly 4h old is `aging` rather than `fresh`.
 * Picking a side matters more than which side: a `>` here would leave the
 * instant of the boundary in the previous band, and a test asserting on
 * "4 hours" would pass or fail on whether it constructed its fixture a
 * millisecond early.
 */
export function stalenessOf(ageMs: number): StalenessLevel {
  if (ageMs >= 3 * DAY) return "abandoned";
  if (ageMs >= DAY) return "stale";
  if (ageMs >= 4 * HOUR) return "aging";
  return "fresh";
}

/**
 * The colour token for a band, or `null` for `fresh`.
 *
 * `null` rather than a transparent colour, so a caller has to decide
 * whether to render the element at all. A transparent dot still occupies
 * layout, and a row of invisible-but-present dots pushes every card's
 * metadata line over by the same amount — meaning the "no indicator" state
 * would silently cost the space of an indicator.
 */
export function stalenessToken(level: StalenessLevel): string | null {
  switch (level) {
    case "fresh":
      return null;
    case "aging":
      return "var(--stale-subtle)";
    case "stale":
      return "var(--stale-warn)";
    case "abandoned":
      return "var(--stale-alert)";
  }
}

/** Agent liveness, as the fleet reads it. */
export type Liveness = "live" | "stalled" | "dead";

/** Liveness → its presence-dot colour token. */
export function presenceToken(liveness: Liveness): string {
  return `var(--presence-${liveness})`;
}
