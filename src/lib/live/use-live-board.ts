"use client";

// The live feed's one piece of React — T17, part 1.
//
// **Everything decidable without React is decided elsewhere.** The cursor
// arithmetic is `./cursor`, the "does this matter to the board" question is
// `./events`, and the transport and its pacing are `./poll` — all pure
// functions over plain data, testable with no DOM. What is left here is the
// part that genuinely needs React: a timer, a mounted flag, and a document
// visibility subscription.
//
// **The defect this file is written to avoid.** A value assigned inside a
// `setState` updater and read outside it is unreliable: React evaluates an
// updater eagerly only when no update is already pending on the fiber, and
// defers it otherwise — and under StrictMode it invokes it twice. That has
// shipped three times in this repo (`scripts/check-updater-side-effects.mjs`
// carries the history). A live feed writing into component state is exactly
// that shape, so **the cursor lives in a ref and is never read out of an
// updater.** The ref is the authoritative copy; the only `setState` here
// takes a plain value, not a function.
import { useCallback, useEffect, useRef, useState } from "react";
import { INITIAL_CURSOR } from "./cursor";
import { touchedItemIds, type LiveEvent } from "./events";
import { backoffDelay, pollLive } from "./poll";

export interface UseLiveBoardOptions {
  /**
   * Called with the slice whenever a poll returns events that matter to the
   * board. **Never called with an empty slice**, so a caller can treat every
   * invocation as "something changed" without checking.
   *
   * Held in a ref internally, so a caller passing an inline closure does not
   * restart the poll loop on every render.
   */
  readonly onEvents: (events: readonly LiveEvent[], touched: readonly string[]) => void;
  /** Turns the feed off entirely — used while the board has not loaded yet. */
  readonly enabled?: boolean;
  /** Injected for tests. Defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Subscribes the board to the events ledger.
 *
 * **Two lifecycle rules, both of which matter on a board left open all day:**
 *
 *   - **Paused while the tab is hidden.** A background tab that keeps
 *     polling is a request every few seconds for a board nobody is looking
 *     at, multiplied by every tab anyone left open. On becoming visible again
 *     it polls **immediately** rather than waiting out an interval, because
 *     the moment a person looks back at the board is exactly when staleness
 *     is most visible. Nothing is missed by pausing: the cursor is held, so
 *     the first poll after waking asks for everything since it.
 *   - **Backed off on failure.** See `backoffDelay` — a failing server must
 *     not be asked every 5 seconds by every open tab.
 *
 * Returns the current cursor, which is useful to a test and to nothing else.
 */
export function useLiveBoard(options: UseLiveBoardOptions): { readonly cursor: string } {
  const { onEvents, enabled = true, fetchImpl } = options;

  // **The cursor is a ref, not state.** It is read by the poll loop and
  // written by its result; nothing renders from it, so holding it in state
  // would schedule a render per poll for a value nothing draws — and would
  // put it exactly one deferral away from the defect in this file's header.
  const cursorRef = useRef(INITIAL_CURSOR);
  // Mirrored into state solely so the return value is stable for a caller
  // that wants to observe it. Written from the ref *after* it has already
  // been advanced, never the other way round.
  const [cursor, setCursor] = useState(INITIAL_CURSOR);
  const failuresRef = useRef(0);

  // The callback, held in a ref so the effect below does not re-run — and so
  // it cannot restart the poll loop — when a caller passes an inline closure.
  // Written in an effect rather than during render: a ref written during
  // render is the thing `react-hooks/refs` is protecting against.
  const onEventsRef = useRef(onEvents);
  useEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);

  const resolvedFetch = fetchImpl;

  const poll = useCallback(async (): Promise<void> => {
    // Read synchronously from the ref, never from an updater's argument —
    // this is the read the header is about.
    const since = cursorRef.current;
    const result = await pollLive(since, resolvedFetch ?? fetch);

    if (!result.ok) {
      failuresRef.current += 1;
      return;
    }
    failuresRef.current = 0;

    // Advanced on the ref first, so a poll that starts before this render
    // commits still asks from the right place.
    if (result.cursor !== cursorRef.current) {
      cursorRef.current = result.cursor;
      setCursor(result.cursor);
    }

    const touched = touchedItemIds(result.events);
    if (touched.length === 0) return;
    onEventsRef.current(result.events, touched);
  }, [resolvedFetch]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hidden = (): boolean =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    const schedule = (delay: number): void => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Hidden: do not poll, but keep the loop alive so it resumes without
      // needing the visibility listener to restart it.
      if (hidden()) {
        schedule(backoffDelay(failuresRef.current));
        return;
      }
      await poll();
      if (cancelled) return;
      schedule(backoffDelay(failuresRef.current));
    };

    // **The first poll is scheduled, not immediate.** The board's own load is
    // in flight at mount; a poll racing it would apply a delta to a board
    // that has not arrived, and the delta's whole effect is a refetch anyway.
    schedule(backoffDelay(0));

    const onVisibility = (): void => {
      if (cancelled || hidden()) return;
      // Became visible: poll now rather than waiting out the pending timer,
      // and reschedule from this moment.
      if (timer !== undefined) clearTimeout(timer);
      void tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, poll]);

  return { cursor };
}
