"use client";

// The Netflix-style picker itself (DECISIONS.md "Profiles, not accounts":
// "Netflix-style profile picker on the front end"). Rendered two ways by
// its caller (`AppShell`):
//
//   - **initial** — no `onClose`. Nothing is active yet, so there is
//     nothing sensible to cancel back to.
//   - **switch** — `onClose` present. An active profile already exists;
//     this is reachable only from the top bar's icon and can be dismissed.
//
// **T13 — the empty state is a create form, not a message.** This was
// literally the product's first screen and a dead end: zero profiles
// rendered "No profiles are set up yet." with no action anywhere on it.
// Create is now always reachable from here — inline and un-dismissable
// when the list is empty (there is nothing else to show), a toggled "+ Add
// profile" tile alongside the others once at least one profile exists.
//
// Hook-free and prop-driven, like every other view in this split
// (`AppShellView`, `SettingsView`): this repo's test harness runs
// `environment: "node"` with no DOM (`vitest.config.ts`), so a component
// taking plain props is called directly as a function and its returned
// tree inspected. All the create-in-progress state (the draft, the pending
// flag, the error) lives in the thin container that renders this — see
// `AppShell.tsx`.
import type { Profile } from "@/lib/profile/types";
import styles from "./ProfilePicker.module.css";

export interface ProfilePickerProps {
  readonly people: readonly Profile[];
  readonly onChoose: (profile: Profile) => void;
  readonly onClose?: () => void;
  /** Whether the create form is open. Forced open (and rendered without a way to collapse it) when `people` is empty — see the header. */
  readonly createOpen: boolean;
  /** What is typed into the create form's name field. */
  readonly createDraft: string;
  /** Set while the create request is in flight, to disable the form rather than let a second submit race the first. */
  readonly creating: boolean;
  /** The message from the last failed create, if any. */
  readonly createError: string | null;
  readonly onToggleCreate: () => void;
  readonly onCreateDraftChange: (raw: string) => void;
  readonly onCreateSubmit: () => void;
}

function initialOf(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || "?";
}

export function ProfilePicker({
  people,
  onChoose,
  onClose,
  createOpen,
  createDraft,
  creating,
  createError,
  onToggleCreate,
  onCreateDraftChange,
  onCreateSubmit,
}: ProfilePickerProps) {
  const empty = people.length === 0;
  // Empty means there is nothing else this dialog can offer, so the create
  // form is shown regardless of the toggle and with nothing to collapse it
  // back to — the same reasoning `ProfilePickerProps.onClose`'s header gives
  // for why the initial picker has no close button at all.
  const showCreateForm = createOpen || empty;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a profile"
      onClick={onClose ? () => onClose() : undefined}
    >
      <div className={styles.panel} onClick={(event) => event.stopPropagation()}>
        <h1 className={styles.heading}>Who&apos;s working?</h1>
        {onClose && (
          <button type="button" className={styles.close} onClick={onClose} aria-label="Cancel">
            ×
          </button>
        )}
        {!empty && (
          <ul className={styles.grid}>
            {people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className={styles.tile}
                  style={person.colour ? { borderColor: person.colour } : undefined}
                  onClick={() => onChoose(person)}
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {person.avatar ?? initialOf(person.displayName)}
                  </span>
                  <span className={styles.name}>{person.displayName}</span>
                </button>
              </li>
            ))}
            {!showCreateForm && (
              <li>
                <button
                  type="button"
                  className={`${styles.tile} ${styles.tileAdd}`}
                  aria-label="Add profile"
                  onClick={onToggleCreate}
                >
                  <span className={styles.avatar} aria-hidden="true">
                    +
                  </span>
                  <span className={styles.name}>Add profile</span>
                </button>
              </li>
            )}
          </ul>
        )}

        {showCreateForm && (
          <form
            className={styles.createForm}
            onSubmit={(event) => {
              event.preventDefault();
              onCreateSubmit();
            }}
          >
            {empty && (
              <p className={styles.empty}>No profiles are set up yet — add one to start.</p>
            )}
            <label className={styles.createLabel} htmlFor="profile-create-name">
              Name
            </label>
            <input
              id="profile-create-name"
              className={styles.createInput}
              type="text"
              value={createDraft}
              placeholder="e.g. Ope"
              disabled={creating}
              autoFocus={empty}
              onChange={(event) => onCreateDraftChange(event.target.value)}
            />
            <div className={styles.createActions}>
              <button
                type="submit"
                className={styles.createSubmit}
                disabled={creating || createDraft.trim() === ""}
              >
                {creating ? "Creating…" : "Create profile"}
              </button>
              {!empty && (
                <button
                  type="button"
                  className={styles.createCancel}
                  disabled={creating}
                  onClick={onToggleCreate}
                >
                  Cancel
                </button>
              )}
            </div>
            {createError && <p className={styles.createError}>{createError}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
