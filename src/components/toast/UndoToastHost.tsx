"use client";

// The undo toast's container — the one place in this piece that holds
// state, reads the clock and talks to the network.
//
// ── Why the mount point is a provider and not just a toast ──────────────
//
// The actions that need undoing happen all over the app: a drag on the
// board, a bulk operation on a selection (T6-E), an archive on an item
// page. None of them is a child of any other, and all of them need to
// reach the same single toast. A context is the only shape that lets a
// component anywhere call `offer(action)` without the toast being threaded
// through every intervening component as a prop.
//
// **This is deliberately the entire public surface for other pieces.** A
// caller does `const { offer } = useUndo()` and calls `offer(action)` after
// its write succeeds. It does not import the toast, does not know where it
// renders, and does not manage the window. That is what keeps the mount in
// `AppShell` a single element — see this file's counterpart there.
//
// ── The split, again ────────────────────────────────────────────────────
//
// Everything decidable without a clock or a network lives in `@/lib/undo`
// as pure functions and is tested directly. This file is wiring: a
// `useState`, an interval, and a `fetch` call. The wiring is the part that
// cannot be tested in a DOM-free harness, so there is deliberately as
// little of it here as possible, and no branching that decides anything —
// every decision below is a call into the pure layer.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  actionOffered,
  idleToast,
  inverseOf,
  remainingMs,
  runUndo,
  ticked,
  undoPressed,
  undoSettled,
  type UndoPlan,
  type UndoToastState,
  type UndoableAction,
} from "@/lib/undo";
import { UndoToast } from "./UndoToast";

/** What a surface anywhere in the app can do with undo. */
export interface UndoApi {
  /**
   * Offer an action back to the person.
   *
   * Call this **after** the write has been accepted, with what the server
   * reported — see `ItemMove`'s note on why `from` must be the server's
   * value and not the UI's guess.
   */
  readonly offer: (action: UndoableAction) => void;
}

/**
 * A no-op default, so a component calling `useUndo()` outside the provider
 * renders instead of throwing.
 *
 * A missing toast is a missing convenience; a thrown error would take down
 * the page that was trying to report a *successful* write. That trade is
 * clear enough to make the safe direction the default — and every real
 * mount is at the shell, so being outside it means being in a test or a
 * fragment render, where silence is right.
 */
const NO_UNDO: UndoApi = { offer: () => {} };

const UndoContext = createContext<UndoApi>(NO_UNDO);

export function useUndo(): UndoApi {
  return useContext(UndoContext);
}

/** How often the countdown re-renders. */
const TICK_MS = 250;

export function UndoToastHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UndoToastState>(idleToast);
  // Drives the countdown and the expiry check. Held as state (not read
  // during render from `Date.now()`) so that a re-render is what makes the
  // number change, rather than the number changing being invisible until
  // something else re-renders.
  const [now, setNow] = useState(() => Date.now());

  // **Expiry is derived during render, not written by an effect.** The
  // stored `state` is what the person last *did*; `visible` is what that
  // amounts to at `now`. Computing it here rather than in a
  // `useEffect(() => setState(ticked(...)))` is the same shape
  // `AppShell.tsx` uses for its mobile nav sheet, and for the same reason:
  // a synchronous `setState` inside an effect is a cascading render, which
  // is what `react-hooks/set-state-in-effect` refuses.
  //
  // `ticked` is total and returns the state unchanged when nothing has
  // expired, so this is a pure function of two values already in hand.
  const visible = ticked(state, now);

  // The offered action, if the toast is showing one — the only phase with
  // a live window. Read off `visible`, so an expired action is already
  // gone.
  const offeredAction = visible.phase === "offered" ? visible.action : null;

  // One interval, and only while something is counting down. An interval
  // that ran permanently would re-render the whole subtree four times a
  // second for the entire life of the app to animate a toast that is not
  // on screen. The dependency is the action itself, so the timer stops the
  // moment the toast stops counting rather than on the next tick.
  useEffect(() => {
    if (offeredAction === null) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [offeredAction]);

  const offer = useCallback((action: UndoableAction) => {
    // Stamp the clock at offer time so the window measures from the
    // action, and reset the tick so the first countdown frame is right.
    setNow(Date.now());
    setState(actionOffered(action));
  }, []);

  // `offer` is stable, so this context value never changes identity and
  // consumers do not re-render when the toast does.
  const api = useMemo<UndoApi>(() => ({ offer }), [offer]);

  // Guards against a settled response overwriting a newer toast. The pure
  // `undoSettled` already refuses unless the phase is `undoing`; this
  // additionally pins it to *this* request, so a slow first undo cannot
  // settle a second one the person started after it.
  const requestId = useRef(0);

  const onUndo = useCallback(() => {
    const pressedAt = Date.now();
    let planToRun: UndoPlan | null = null;
    setState((current) => {
      // Checked against `current` — the STORED state, which may still say
      // `offered` for an action that `visible` has already expired. That is
      // safe rather than a gap: `undoPressed` re-checks the window itself
      // against `pressedAt`, so an expired action is refused here on its
      // own merits and does not depend on the render having caught up.
      const next = undoPressed(current, pressedAt);
      // `undoPressed` returns the state unchanged when the press must not
      // take effect (wrong phase, expired, double press). Comparing
      // identity is how this knows whether to send anything.
      if (next !== current && next.phase === "undoing") planToRun = inverseOf(next.action);
      return next;
    });
    if (planToRun === null) return;
    const id = ++requestId.current;
    void runUndo(planToRun).then((outcome) => {
      if (id !== requestId.current) return;
      setState((current) => undoSettled(current, outcome));
    });
  }, []);

  const onDismiss = useCallback(() => setState(idleToast), []);

  // Both derived from the pure layer. `plan` is what decides whether the
  // button renders; `secondsLeft` is the countdown, rounded up so it shows
  // "1s" for the whole final second rather than "0s".
  const plan = offeredAction === null ? null : inverseOf(offeredAction);
  const secondsLeft =
    offeredAction === null ? null : Math.ceil(remainingMs(offeredAction, now) / 1000);

  return (
    <UndoContext.Provider value={api}>
      {children}
      <UndoToast
        state={visible}
        plan={plan}
        secondsLeft={secondsLeft}
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    </UndoContext.Provider>
  );
}
