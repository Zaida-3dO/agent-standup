"use client";

// The thin container: fetches one kind's rows, holds the per-row editor
// state, and hands everything to `AdminView` as plain props. Kept
// deliberately empty of branching and of rules — see `AdminView.tsx` for why
// the conditionals live there, and `@/lib/admin/` for the derivation and the
// request shaping, both directly testable.
//
// **No database access, and none possible.** Every call goes to the HTTP
// adapter, which is itself a thin shell over one `service.call` (CLAUDE.md:
// "Every adapter is a thin shell over a service call"). Nothing under
// `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import type { AdminKind } from "@/lib/admin/kinds";
import {
  adminErrorMessageFrom,
  buildPatchBody,
  createRow,
  fetchRows,
  isOverridden,
  setArchived,
  updateRow,
  type AdminLoadState,
  type AdminRow,
} from "@/lib/admin/state";
import { fromInput } from "@/lib/admin/values";
import { AdminView, CREATE_ERROR_KEY } from "./AdminView";

type PerRow<T> = Record<string, Record<string, T>>;

export function Admin({ kind }: { kind: AdminKind }) {
  const [loadState, setLoadState] = useState<AdminLoadState>({ status: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PerRow<string>>({});
  const [inheriting, setInheriting] = useState<PerRow<boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createDrafts, setCreateDrafts] = useState<Record<string, string>>({});

  // Promise-chained rather than `await`ed so every `setState` sits inside an
  // asynchronous callback — the shape `ProfileProvider` uses, and what
  // `react-hooks/set-state-in-effect` asks for.
  //
  // **The effect does not reset to `loading` first**, deliberately. Doing so
  // synchronously in the effect body is the cascading render that rule
  // exists to stop, and it is not needed: the request that arrives writes
  // the state, and a stale render of the previous kind's rows for one frame
  // is a far smaller problem than a page that flashes empty on every filter
  // toggle. The `cancelled` flag is what makes it correct — an answer that
  // arrives after the effect it belongs to has been torn down is dropped
  // rather than rendered over whatever is on screen.
  useEffect(() => {
    let cancelled = false;
    fetchRows(kind, { includeArchived })
      .then((rows) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: adminErrorMessageFrom(err, kind) });
      });
    return () => {
      cancelled = true;
    };
  }, [kind, includeArchived]);

  const reload = useCallback(
    () =>
      fetchRows(kind, { includeArchived })
        .then((rows) => {
          setLoadState({ status: "loaded", rows });
        })
        .catch((err: unknown) => {
          setLoadState({ status: "error", message: adminErrorMessageFrom(err, kind) });
        }),
    [kind, includeArchived],
  );

  const setError = useCallback((key: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  }, []);

  const rowById = useCallback(
    (id: string): AdminRow | undefined =>
      loadState.status === "loaded"
        ? loadState.rows.find((row) => String(row[kind.idField] ?? "") === id)
        : undefined,
    [kind.idField, loadState],
  );

  /**
   * Turns one row's drafts and inherit choices into the values to send.
   *
   * An override field set to inherit becomes an explicit `null` — that is
   * how §17.7's columns spell "no override" — and is included even if the
   * text box was never touched, because choosing to inherit *is* the edit.
   */
  const collect = useCallback(
    (id: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } => {
      const row = rowById(id);
      const rowDrafts = drafts[id] ?? {};
      const rowInherit = inheriting[id] ?? {};
      const values: Record<string, unknown> = {};

      for (const field of kind.fields) {
        if (field.readOnly) continue;

        if (field.overridesSetting) {
          const wasInheriting = row ? !isOverridden(row, field) : true;
          const nowInheriting = rowInherit[field.name] ?? wasInheriting;
          if (nowInheriting) {
            // Only sent when it is a change: re-sending `null` for a field
            // that was already inheriting would be a write nobody asked for,
            // and every #92 schema treats an omitted field as "no change".
            if (!wasInheriting) values[field.name] = null;
            continue;
          }
        }

        const raw = rowDrafts[field.name];
        if (raw === undefined) continue;
        const parsed = fromInput(raw, field);
        if (!parsed.ok) return { ok: false, message: `${field.label}: ${parsed.error}` };
        values[field.name] = parsed.value;
      }

      return { ok: true, body: buildPatchBody(kind, values) };
    },
    [drafts, inheriting, kind, rowById],
  );

  const onSave = useCallback(
    (id: string) => {
      const collected = collect(id);
      if (!collected.ok) {
        setError(id, collected.message);
        return;
      }
      void updateRow(kind, id, collected.body).then((outcome) => {
        if (!outcome.ok) {
          setError(id, outcome.message);
          return;
        }
        setError(id, null);
        setDrafts((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setInheriting((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setExpandedId(null);
        void reload();
      });
    },
    [collect, kind, reload, setError],
  );

  const onArchive = useCallback(
    (id: string, archived: boolean) => {
      void setArchived(kind, id, archived).then((outcome) => {
        if (!outcome.ok) {
          setError(id, outcome.message);
          return;
        }
        setError(id, null);
        void reload();
      });
    },
    [kind, reload, setError],
  );

  const onCreate = useCallback(() => {
    const body: Record<string, unknown> = {};
    for (const field of kind.fields) {
      const raw = createDrafts[field.name];
      if (raw === undefined || raw === "") continue;
      const parsed = fromInput(raw, field);
      if (!parsed.ok) {
        setError(CREATE_ERROR_KEY, `${field.label}: ${parsed.error}`);
        return;
      }
      // A create sends only what was filled in; the operation's own schema
      // decides what is required and says which field is missing.
      if (parsed.value !== null) body[field.name] = parsed.value;
    }

    void createRow(kind, body).then((outcome) => {
      if (!outcome.ok) {
        setError(CREATE_ERROR_KEY, outcome.message);
        return;
      }
      setError(CREATE_ERROR_KEY, null);
      setCreateDrafts({});
      setCreateOpen(false);
      void reload();
    });
  }, [createDrafts, kind, reload, setError]);

  return (
    <AdminView
      kind={kind}
      loadState={loadState}
      includeArchived={includeArchived}
      expandedId={expandedId}
      drafts={drafts}
      inheriting={inheriting}
      errors={errors}
      createOpen={createOpen}
      createDrafts={createDrafts}
      onToggleArchivedFilter={setIncludeArchived}
      onToggleRow={(id) => setExpandedId((current) => (current === id ? null : id))}
      onDraftChange={(id, name, raw) =>
        setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? {}), [name]: raw } }))
      }
      onInheritChange={(id, name, value) =>
        setInheriting((current) => ({
          ...current,
          [id]: { ...(current[id] ?? {}), [name]: value },
        }))
      }
      onSave={onSave}
      onArchive={onArchive}
      onToggleCreate={() => setCreateOpen((open) => !open)}
      onCreateDraftChange={(name, raw) =>
        setCreateDrafts((current) => ({ ...current, [name]: raw }))
      }
      onCreate={onCreate}
    />
  );
}
