// The presentational half of MILESTONES.md #93: the kind tabs, the
// load/error/loaded branching, the row list, and the create form.
//
// **One component for every entity kind.** Everything specific to a kind
// arrives in its descriptor (`@/lib/admin/kinds`), so adding a kind is
// adding an entry to that list — not writing a fifth page that has to be
// kept in step with four others.
//
// Prop-driven and hook-free — same reasoning as `BoardView.tsx` and
// `SettingsView.tsx`. `Admin.tsx` is the thin client container.
import Link from "next/link";
import { ADMIN_KINDS, createFields, type AdminKind } from "@/lib/admin/kinds";
import type { AdminLoadState } from "@/lib/admin/state";
import { AdminField } from "./AdminField";
import { AdminRow } from "./AdminRow";
import styles from "./Admin.module.css";

export interface AdminViewProps {
  readonly kind: AdminKind;
  readonly loadState: AdminLoadState;
  readonly includeArchived: boolean;
  /** Which row is open for editing, by id. */
  readonly expandedId: string | null;
  /** Per-row drafts, keyed by row id then field name. */
  readonly drafts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Per-row inherit choices, keyed by row id then field name. */
  readonly inheriting: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** Per-row error messages, plus the create form's under the empty-string key. */
  readonly errors: Readonly<Record<string, string>>;
  readonly createOpen: boolean;
  readonly createDrafts: Readonly<Record<string, string>>;
  readonly onToggleArchivedFilter: (includeArchived: boolean) => void;
  readonly onToggleRow: (id: string) => void;
  readonly onDraftChange: (id: string, name: string, raw: string) => void;
  readonly onInheritChange: (id: string, name: string, inheriting: boolean) => void;
  readonly onSave: (id: string) => void;
  readonly onArchive: (id: string, archived: boolean) => void;
  readonly onToggleCreate: () => void;
  readonly onCreateDraftChange: (name: string, raw: string) => void;
  readonly onCreate: () => void;
}

/** The key the create form's own error is stored under — never a valid row id. */
export const CREATE_ERROR_KEY = "";

export function AdminView(props: AdminViewProps) {
  const { kind, loadState } = props;

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Administration</h1>
      <p className={styles.blurb}>
        Repositories, areas, machines, accounts and people — the data this installation owns. These
        are not settings: this build cannot know them, and there is no sensible default for one.{" "}
        <Link className={styles.tab} href="/settings">
          Settings
        </Link>
      </p>

      <ul className={styles.tabs}>
        {ADMIN_KINDS.map((entry) => (
          <li key={entry.slug}>
            <Link
              className={
                entry.slug === kind.slug ? `${styles.tab} ${styles.tabActive}` : styles.tab
              }
              href={`/admin/${entry.slug}`}
            >
              {entry.title}
            </Link>
          </li>
        ))}
      </ul>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{kind.title}</h2>
        <p className={styles.note}>{kind.blurb}</p>

        <div className={styles.actions}>
          {kind.canArchive && (
            <label className={styles.help}>
              <input
                type="checkbox"
                checked={props.includeArchived}
                aria-label="Show archived"
                onChange={(event) => props.onToggleArchivedFilter(event.target.checked)}
              />{" "}
              Show archived
            </label>
          )}
          {kind.canCreate && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={props.onToggleCreate}
            >
              {/* Closing the create form discards a draft; it does not cancel
                  anything that exists. Matches `QuickCreateDialog`'s dismiss
                  label — the same act on the other create path — per the
                  convention in `ArchiveAction`'s header. */}
              {props.createOpen ? "Discard draft" : `New ${kind.singular}`}
            </button>
          )}
        </div>

        {props.createOpen && kind.canCreate && (
          <>
            <ul className={styles.fields}>
              {createFields(kind).map((field) => (
                <AdminField
                  key={field.name}
                  // The create form offers the identifier, which the edit
                  // form does not: "cannot be changed afterwards" and
                  // "cannot be set at all" are different things.
                  field={field.readOnly ? { ...field, readOnly: false } : field}
                  stored=""
                  draft={props.createDrafts[field.name]}
                  inheriting={false}
                  onChange={props.onCreateDraftChange}
                  onInheritChange={() => {}}
                />
              ))}
            </ul>
            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                onClick={props.onCreate}
              >
                Create {kind.singular}
              </button>
            </div>
            {props.errors[CREATE_ERROR_KEY] && (
              <p className={styles.error}>{props.errors[CREATE_ERROR_KEY]}</p>
            )}
          </>
        )}

        {loadState.status === "error" && <p className={styles.error}>{loadState.message}</p>}
        {loadState.status === "loading" && (
          <p className={styles.empty}>Loading {kind.title.toLowerCase()}…</p>
        )}
        {loadState.status === "loaded" &&
          (loadState.rows.length === 0 ? (
            <p className={styles.empty}>No {kind.title.toLowerCase()} yet.</p>
          ) : (
            <ul className={styles.rows}>
              {loadState.rows.map((row) => {
                const id = String(row[kind.idField] ?? "");
                return (
                  <AdminRow
                    key={id}
                    kind={kind}
                    row={row}
                    expanded={props.expandedId === id}
                    drafts={props.drafts[id] ?? {}}
                    inheriting={props.inheriting[id] ?? {}}
                    error={props.errors[id]}
                    onToggle={props.onToggleRow}
                    onDraftChange={props.onDraftChange}
                    onInheritChange={props.onInheritChange}
                    onSave={props.onSave}
                    onArchive={props.onArchive}
                  />
                );
              })}
            </ul>
          ))}
      </section>
    </div>
  );
}
