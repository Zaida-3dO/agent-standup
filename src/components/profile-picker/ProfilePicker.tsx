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
import { personColour } from "@/lib/design/person-colour";
import styles from "./ProfilePicker.module.css";

export interface ProfilePickerProps {
  readonly people: readonly Profile[];
  readonly onChoose: (profile: Profile) => void;
  readonly onClose?: () => void;
  /**
   * The active profile, if any — T22.
   *
   * **Selection is rendered on its own channel, never on the person's
   * colour.** The tile's border is the person's identity, so before this
   * existed the active profile rendered plain grey whenever its `colour` was
   * unset while an inactive one glowed pink — selection signalled by the one
   * colour that does not mean selection. The active tile now carries a
   * separate `--accent` ring, a "Current" label and `aria-current`, none of
   * which any inactive tile can ever show whatever colour it happens to
   * have.
   *
   * `null`/absent means nothing is active, which is the initial picker: no
   * tile marks itself, rather than the first one doing so by default.
   */
  readonly activeProfileId?: string | null;
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
  activeProfileId,
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
            {people.map((person) => {
              // T22. Two separate facts, deliberately on two separate
              // channels: the border says WHO (identity), the ring and the
              // label say WHICH (state). Painting selection with the
              // person's own colour is what made an inactive pink tile
              // outrank the active colourless one.
              const current = activeProfileId != null && person.id === activeProfileId;
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    className={`${styles.tile} ${current ? styles.tileCurrent : ""}`}
                    // Every person has a colour, stored or derived — see
                    // `personColour`. No tile renders without an identity
                    // colour, so a plain grey tile never reads as a
                    // meaningful state.
                    style={{ borderColor: personColour(person) }}
                    // The non-visual half of the same signal. Without it a
                    // screen-reader user got NO indication of which profile
                    // was active while a sighted user got a misleading one
                    // — WCAG 4.1.2. `undefined` rather than `"false"` so
                    // the attribute is simply absent on inactive tiles.
                    aria-current={current ? "true" : undefined}
                    onClick={() => onChoose(person)}
                  >
                    <span className={styles.avatar} aria-hidden="true">
                      {person.avatar ?? initialOf(person.displayName)}
                    </span>
                    <span className={styles.name}>{person.displayName}</span>
                    {/* A third channel, and the only one that survives both
                        monochrome rendering and a colour-blind reader: the
                        word itself. `globals.css` treats colour as never the
                        sole carrier of a fact. */}
                    {current && <span className={styles.currentLabel}>Current</span>}
                  </button>
                </li>
              );
            })}
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
