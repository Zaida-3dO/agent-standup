"use client";

// The budget-window editor's container — MILESTONES.md #87, SCHEMA.md §17.4.
//
// Holds the draft, parses it on every keystroke, and owns the save. All the
// deciding lives in `@/lib/budget-page/edit` and `@/lib/settings/budget-windows`;
// what is here is the wiring, kept as thin as the container half of this page
// already is.
//
// **No database access, and none possible.** Every call goes to the HTTP
// adapter — `npm run check:db-imports` enforces that independently of lint.
//
// ── Concurrent edits: what this does, and what it does not claim ────────
//
// `budget.windows` is one setting holding a map, so saving is a
// read-modify-write of the whole object and two sessions saving at once
// would have the later silently overwrite the earlier — including deleting
// a window the other had just added.
//
// **`put_setting` has no precondition parameter to use.** Its input schema
// is `z.object({ key, value }).strict()`, so an `expectedRevision` sent
// alongside would be *rejected*, not ignored. #257's `expectedFrom` shape
// is the right idea, but giving it to settings means changing a core write
// operation and every surface that calls it — a service-layer change, not a
// UI one.
//
// So this does the strongest thing available from the client: it records
// what it loaded, **re-reads immediately before writing**, and refuses the
// save when the stored value has changed underneath it, showing what
// changed and offering to reload. Last-write-wins was rejected outright —
// the criterion is that a concurrent edit is not *silently* clobbered.
//
// This narrows the race to the window between the check and the write; it
// does not close it, and it is not atomic. Closing it needs the server-side
// precondition above. That is stated plainly rather than dressed up,
// because a comment claiming safety this code does not provide is worse
// than the race itself.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  findCrossings,
  type BudgetWindows,
  type CrossingProblem,
} from "@/lib/settings/budget-windows";
import {
  budgetErrorMessageFrom,
  fetchWindows,
  writeWindows,
  type BudgetLoadState,
} from "@/lib/budget-page/state";
import {
  draftIncompleteness,
  windowFromDraft,
  windowsFromDraft,
  windowsToDraft,
  withWindow,
  withWindowAdded,
  withWindowRemoved,
  type WindowsDraft,
} from "@/lib/budget-page/edit";
import { describeConcurrentChange, sameWindows } from "@/lib/budget-page/concurrency";
import { scrubbedTo } from "@/lib/budget-page/scrubber";
import { BudgetEditorView } from "./BudgetEditorView";

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string }
  /** The stored value moved under us — the save was refused, not applied. */
  | { status: "conflict"; message: string; theirs: BudgetWindows };

export function BudgetEditor() {
  const [loadState, setLoadState] = useState<BudgetLoadState>({ status: "loading" });
  const [draft, setDraft] = useState<WindowsDraft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /**
   * Scrubber position per window, in hours. A window absent from this map
   * has not been scrubbed, and its chart follows the first collision — see
   * `WindowEditor`'s `atHours` prop for why absence is not just zero.
   */
  const [scrubbed, setScrubbed] = useState<Record<string, number>>({});

  /**
   * What was loaded, as the comparison baseline for the conflict check.
   *
   * A ref rather than state because the save handler must read it
   * **synchronously, at the moment it runs**, and a render-time value would
   * be whatever it was when the handler was created. This is the same
   * discipline `scripts/check-updater-side-effects.mjs` exists to enforce
   * from the other direction: nothing below assigns into a `setState`
   * updater and reads it afterwards.
   */
  const baseline = useRef<BudgetWindows | null>(null);
  /** Guards against a second save while one is in flight — read before, not inside, a setState. */
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Promise-chained rather than awaited, so every setState sits in an
    // async callback — what `react-hooks/set-state-in-effect` asks for.
    fetchWindows()
      .then((windows) => {
        if (cancelled) return;
        baseline.current = windows;
        setLoadState({ status: "loaded", windows });
        setDraft(windowsToDraft(windows));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: budgetErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The draft parsed, and its crossings — recomputed whenever the draft
   * changes, which is what makes a collision appear as it is typed.
   *
   * Derived rather than stored, for the reason the viewer gives: a
   * validation result held in state is one that can disagree with the value
   * it describes.
   */
  const parsed = useMemo(() => {
    const out: Record<string, ReturnType<typeof windowFromDraft>> = {};
    if (draft === null) return out;
    for (const name of draft.names) {
      const windowDraft = draft.windows[name];
      out[name] = windowDraft === undefined ? null : windowFromDraft(windowDraft);
    }
    return out;
  }, [draft]);

  const problems = useMemo<Record<string, readonly CrossingProblem[]>>(() => {
    const found: Record<string, readonly CrossingProblem[]> = {};
    for (const [name, window] of Object.entries(parsed)) {
      found[name] = window === null ? [] : findCrossings(window);
    }
    return found;
  }, [parsed]);

  const incompleteness = useMemo<Record<string, string | null>>(() => {
    const out: Record<string, string | null> = {};
    if (draft === null) return out;
    for (const name of draft.names) {
      const windowDraft = draft.windows[name];
      out[name] = windowDraft === undefined ? null : draftIncompleteness(windowDraft);
    }
    return out;
  }, [draft]);

  /** Nothing may be saved while any window is incomplete or any collides. */
  const blockedReason = useMemo<string | null>(() => {
    if (draft === null) return "Still loading.";
    for (const name of draft.names) {
      const reason = incompleteness[name];
      if (reason != null) return `${name}: ${reason}`;
    }
    for (const name of draft.names) {
      if ((problems[name] ?? []).length > 0) {
        return `${name} has boundaries that collide. Fix them before saving.`;
      }
    }
    return null;
  }, [draft, incompleteness, problems]);

  const onChangeWindow = useCallback((name: string, next: Parameters<typeof withWindow>[2]) => {
    setSaveState({ status: "idle" });
    setDraft((current) => (current === null ? current : withWindow(current, name, next)));
  }, []);

  /**
   * Moves one window's scrubber.
   *
   * Clamped through `scrubbedTo` against the window's own length, so a
   * position outside the window cannot be stored. Reads the length from
   * `parsed` rather than the draft, because the draft's `lengthHours` is
   * free text and may not be a number at all mid-edit.
   */
  const onScrub = useCallback(
    (name: string, atHours: number) => {
      const window = parsed[name];
      if (window === undefined || window === null) return;
      setScrubbed((current) => {
        const next = scrubbedTo({ atHours: current[name] ?? 0 }, atHours, window.lengthHours);
        return { ...current, [name]: next.atHours };
      });
    },
    [parsed],
  );

  const onRemoveWindow = useCallback((name: string) => {
    setSaveState({ status: "idle" });
    setDraft((current) => (current === null ? current : withWindowRemoved(current, name)));
  }, []);

  /**
   * Adds a window.
   *
   * The refusal is computed **before** the `setDraft`, and the updater is a
   * pure function of its argument — the shape the updater-side-effects
   * check requires. Deciding inside the updater and reading the answer
   * afterwards is the defect that has shipped three times in this repo.
   */
  const onAddWindow = useCallback(() => {
    const current = draft;
    if (current === null) return;
    const attempt = withWindowAdded(current, newName);
    if (!attempt.ok) {
      setAddError(attempt.message);
      return;
    }
    setAddError(null);
    setNewName("");
    setSaveState({ status: "idle" });
    setDraft(attempt.draft);
  }, [draft, newName]);

  /**
   * Saves, refusing if the stored value moved since it was loaded.
   *
   * Everything decided here is decided from values read synchronously at
   * the top; no `setState` updater below computes anything the rest of this
   * function then reads.
   */
  const onSave = useCallback(async () => {
    if (saving.current) return;
    const current = draft;
    if (current === null) return;
    const value = windowsFromDraft(current);
    if (value === null) return;

    saving.current = true;
    setSaveState({ status: "saving" });
    try {
      // Re-read before writing. This is the conflict check, and it is a
      // check-then-act — see the header for exactly what that does and does
      // not guarantee.
      let theirs: BudgetWindows;
      try {
        theirs = await fetchWindows();
      } catch (err: unknown) {
        setSaveState({
          status: "error",
          message: `Could not check for other changes before saving: ${budgetErrorMessageFrom(err)}`,
        });
        return;
      }

      const mine = baseline.current;
      if (mine !== null && !sameWindows(mine, theirs)) {
        setSaveState({
          status: "conflict",
          message: describeConcurrentChange(mine, theirs),
          theirs,
        });
        return;
      }

      const outcome = await writeWindows(value);
      if (!outcome.ok) {
        setSaveState({ status: "error", message: outcome.message });
        return;
      }
      baseline.current = value;
      setLoadState({ status: "loaded", windows: value });
      setSaveState({ status: "saved" });
    } finally {
      saving.current = false;
    }
  }, [draft]);

  /** Takes the other session's value, discarding this draft — an explicit choice. */
  const onTakeTheirs = useCallback(() => {
    const state = saveState;
    if (state.status !== "conflict") return;
    baseline.current = state.theirs;
    setLoadState({ status: "loaded", windows: state.theirs });
    setDraft(windowsToDraft(state.theirs));
    setSaveState({ status: "idle" });
  }, [saveState]);

  return (
    <BudgetEditorView
      loadState={loadState}
      draft={draft}
      parsed={parsed}
      problems={problems}
      incompleteness={incompleteness}
      blockedReason={blockedReason}
      saveState={saveState}
      newName={newName}
      addError={addError}
      scrubbed={scrubbed}
      onNewNameChange={setNewName}
      onScrub={onScrub}
      onAddWindow={onAddWindow}
      onChangeWindow={onChangeWindow}
      onRemoveWindow={onRemoveWindow}
      onSave={() => {
        void onSave();
      }}
      onTakeTheirs={onTakeTheirs}
    />
  );
}
