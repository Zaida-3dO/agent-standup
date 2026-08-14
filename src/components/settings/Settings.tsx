"use client";

// The thin container: fetches `GET /api/settings`, holds the per-field
// editor and confirmation text, and hands everything to `SettingsView` as
// plain props. Kept deliberately empty of branching and of policy — see
// `SettingsView.tsx` for why the conditionals live there, and
// `@/lib/settings-page/` for where the derivation and the confirmation gate
// live, both directly testable.
//
// **No database access, and none possible.** Every call goes to the HTTP
// adapter, which is itself a thin shell over one `service.call` (CLAUDE.md:
// "Every adapter is a thin shell over a service call"). Nothing under
// `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import {
  fetchSettings,
  removeUnrecognised,
  settingsErrorMessageFrom,
  writeSetting,
  type SettingsLoadState,
} from "@/lib/settings-page/state";
import { inputToValue, valueToInput, widgetFor } from "@/lib/settings-page/widget";
import { SETTINGS_REGISTRY, isSettingKey } from "@/lib/settings";
import { SettingsView } from "./SettingsView";

export function Settings() {
  const [loadState, setLoadState] = useState<SettingsLoadState>({ status: "loading" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * Re-reads the page. Promise-chained rather than `await`ed, so every
   * `setState` sits inside an asynchronous callback — the shape
   * `ProfileProvider` already uses, and what `react-hooks/set-state-in-effect`
   * is asking for: a `setState` reachable synchronously from an effect body
   * causes a cascading render.
   */
  const load = useCallback(
    () =>
      fetchSettings()
        .then((response) => {
          setLoadState({ status: "loaded", response });
        })
        .catch((err: unknown) => {
          setLoadState({ status: "error", message: settingsErrorMessageFrom(err) });
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((response) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", response });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: settingsErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setError = useCallback((key: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  }, []);

  /**
   * Clears a field's editor and confirmation text after a successful write,
   * then reloads.
   *
   * **The confirmation is cleared on success specifically**, so a second
   * change to the same guarded key needs it typed again. Leaving it in place
   * would mean the gate is passed once per page load rather than once per
   * write, which is a materially weaker promise than SCHEMA.md §17.8 makes.
   */
  const afterWrite = useCallback(
    async (key: string) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setConfirmations((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setError(key, null);
      await load();
    },
    [load, setError],
  );

  const onSave = useCallback(
    (key: string) => {
      if (!isSettingKey(key)) {
        setError(key, `${key} is not a setting this build declares.`);
        return;
      }
      const widget = widgetFor(SETTINGS_REGISTRY[key].schema);
      const state = loadState;
      const served =
        state.status === "loaded"
          ? state.response.settings.find((setting) => setting.key === key)
          : undefined;
      const stored = valueToInput(served?.value ?? SETTINGS_REGISTRY[key].default, widget);
      const raw = drafts[key] ?? stored;

      const parsed = inputToValue(raw, widget);
      if (!parsed.ok) {
        setError(key, parsed.error);
        return;
      }

      void writeSetting({
        key,
        verb: "set",
        value: parsed.value,
        typed: confirmations[key] ?? null,
      }).then(async (outcome) => {
        if (!outcome.ok) {
          setError(key, outcome.message);
          return;
        }
        await afterWrite(key);
      });
    },
    [afterWrite, confirmations, drafts, loadState, setError],
  );

  const onReset = useCallback(
    (key: string) => {
      void writeSetting({ key, verb: "reset", typed: confirmations[key] ?? null }).then(
        async (outcome) => {
          if (!outcome.ok) {
            setError(key, outcome.message);
            return;
          }
          await afterWrite(key);
        },
      );
    },
    [afterWrite, confirmations, setError],
  );

  const onRemoveUnrecognised = useCallback(
    (key: string) => {
      void removeUnrecognised(key).then(async (outcome) => {
        if (!outcome.ok) {
          setError(key, outcome.message);
          return;
        }
        await afterWrite(key);
      });
    },
    [afterWrite, setError],
  );

  return (
    <SettingsView
      loadState={loadState}
      drafts={drafts}
      confirmations={confirmations}
      errors={errors}
      onDraftChange={(key, raw) => setDrafts((current) => ({ ...current, [key]: raw }))}
      onConfirmChange={(key, raw) => setConfirmations((current) => ({ ...current, [key]: raw }))}
      onSave={onSave}
      onReset={onReset}
      onRemoveUnrecognised={onRemoveUnrecognised}
    />
  );
}
