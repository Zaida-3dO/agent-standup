"use client";

// The undo affordance — T18's toast with a time-limited action.
//
// ── Hook-free and prop-driven, like every other view in this split ──────
//
// This repo's harness runs `environment: "node"` with no DOM
// (`vitest.config.ts`), so a component taking plain props is called
// directly as a function and its returned tree inspected
// (`tests/helpers/react-element.ts`). All the moving parts — the current
// action, the countdown, the in-flight flag — live in `UndoToastHost`,
// which is the thin container that owns the timer. Introducing `useState`
// here would make the component untestable in this harness, which is why
// the whole `src/components/` tree is written this way.
//
// ── The button is absent, not disabled, when it cannot work ─────────────
//
// A button that cannot do anything is worse than no button at all. A
// disabled one still reads as an offer being withheld and invites the
// person to wonder what they did wrong. There are two ways undo is
// unavailable and both render the same way — no button:
//
//   - **The window expired.** The host stops rendering the toast entirely
//     (`ticked` returns idle), so this component never sees that case.
//   - **The action has no inverse** — an archive, because the service
//     layer has no unarchive path (see `inverseOf`). Here the
//     toast still renders, because the confirmation "Archived X" is worth
//     showing; it simply carries no action. The reason travels with the
//     plan so this does not have to know why.
import type { UndoPlan, UndoToastState } from "@/lib/undo";
import { describeAction } from "@/lib/undo";
import styles from "./UndoToast.module.css";

export interface UndoToastProps {
  readonly state: UndoToastState;
  /**
   * Whether the offered action can still be undone, and if not, why.
   *
   * Passed in rather than derived here because the answer depends on the
   * clock, and reading the clock during render would make this component's
   * output non-deterministic — the one property the DOM-free harness
   * depends on. The host holds the timer and hands down the answer.
   */
  readonly plan: UndoPlan | null;
  /** Seconds left on the window, for the countdown. Null when not counting. */
  readonly secondsLeft: number | null;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}

/** What the toast says while the undo is in flight and after it settles. */
const PHASE_MESSAGE = {
  undoing: "Undoing…",
  undone: "Undone.",
} as const;

export function UndoToast({ state, plan, secondsLeft, onUndo, onDismiss }: UndoToastProps) {
  if (state.phase === "idle") return null;

  const message =
    state.phase === "offered"
      ? describeAction(state.action)
      : state.phase === "undoing"
        ? PHASE_MESSAGE.undoing
        : state.phase === "undone"
          ? PHASE_MESSAGE.undone
          : state.message;

  // Only an offered action with an available inverse gets a button.
  const showUndo = state.phase === "offered" && plan !== null && plan.available;
  // The reason an offered action cannot be undone, shown instead of the
  // button so the toast explains itself rather than looking truncated.
  const unavailableReason =
    state.phase === "offered" && plan !== null && !plan.available ? plan.reason : null;

  return (
    <div
      className={styles.toast}
      // `status` rather than `alert`: this reports something the person
      // just did, so it should not interrupt what a screen reader is
      // already saying. An error phase is still a report of their own
      // action, not an unprompted warning.
      role="status"
      // Announced as a whole once settled, rather than word by word as the
      // countdown ticks — an `aria-live` region containing a changing
      // number would otherwise be read out every second.
      aria-live="polite"
      aria-atomic="true"
      data-phase={state.phase}
    >
      <p className={styles.message}>{message}</p>
      {unavailableReason !== null ? <p className={styles.reason}>{unavailableReason}</p> : null}
      <div className={styles.actions}>
        {showUndo ? (
          <button type="button" className={styles.undo} onClick={onUndo}>
            Undo
            {secondsLeft !== null ? (
              <span className={styles.countdown}> {secondsLeft}s</span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    </div>
  );
}
