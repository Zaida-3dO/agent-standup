"use client";

// The thin container for the interventions section: fetches
// `GET /api/interventions/settings`, holds the per-entry error and in-flight
// state, and hands everything to `InterventionsView` as plain props. Kept
// deliberately empty of branching and of policy — see `InterventionsView`
// for where the conditionals live and `@/lib/interventions-page/` for the
// derivation, both directly testable.
//
// **No database access, and none possible.** Every call goes to the HTTP
// adapter, which is itself a thin shell over one `service.call`. Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import {
  fetchInterventionSettings,
  interventionsErrorMessageFrom,
  writeInterventionLevel,
  type InterventionsLoadState,
} from "@/lib/interventions-page/state";
import type { LevelChoice } from "@/lib/interventions/configurable";
import { InterventionsView } from "./InterventionsView";

export function Interventions() {
  const [loadState, setLoadState] = useState<InterventionsLoadState>({ status: "loading" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, true>>({});

  /**
   * Re-reads the section. Promise-chained rather than `await`ed, so every
   * `setState` sits inside an asynchronous callback — the shape `Settings`
   * already uses, and what `react-hooks/set-state-in-effect` is asking for:
   * a `setState` reachable synchronously from an effect body causes a
   * cascading render.
   */
  const load = useCallback(
    () =>
      fetchInterventionSettings()
        .then((response) => {
          setLoadState({ status: "loaded", response });
        })
        .catch((err: unknown) => {
          setLoadState({ status: "error", message: interventionsErrorMessageFrom(err) });
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchInterventionSettings()
      .then((response) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", response });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: interventionsErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setError = useCallback((id: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }, []);

  const clearPending = useCallback((id: string) => {
    setPending((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * Applies a chosen level and reloads.
   *
   * **Reloads rather than patching the held state**, and that is not
   * laziness. The server is the only thing that can say whether a row now
   * exists — which is the difference between "inherit" and a level that
   * happens to equal the default — so rebuilding from its answer is the only
   * way the badge and the selected option stay true. Writing the optimistic
   * value locally would show "Set here" for a write that was refused, or
   * hide it for one that succeeded.
   */
  const onChoose = useCallback(
    (id: string, choice: LevelChoice) => {
      setPending((current) => ({ ...current, [id]: true }));
      setError(id, null);
      void writeInterventionLevel({ id, choice }).then(async (outcome) => {
        if (!outcome.ok) {
          setError(id, outcome.message);
          clearPending(id);
          return;
        }
        await load();
        clearPending(id);
      });
    },
    [clearPending, load, setError],
  );

  return (
    <InterventionsView
      loadState={loadState}
      errors={errors}
      pending={pending}
      onChoose={onChoose}
    />
  );
}
