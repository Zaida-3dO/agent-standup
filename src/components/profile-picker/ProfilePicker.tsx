"use client";

// The Netflix-style picker itself (DECISIONS.md "Profiles, not accounts":
// "Netflix-style profile picker on the front end"). Rendered two ways by
// its caller (`AppShell`):
//
//   - **initial** — no `onClose`. Nothing is active yet, so there is
//     nothing sensible to cancel back to.
//   - **switch** — `onClose` present. An active profile already exists;
//     this is reachable only from the top bar's icon and can be dismissed.
import type { Profile } from "@/lib/profile/types";
import styles from "./ProfilePicker.module.css";

export interface ProfilePickerProps {
  readonly people: readonly Profile[];
  readonly onChoose: (profile: Profile) => void;
  readonly onClose?: () => void;
}

function initialOf(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || "?";
}

export function ProfilePicker({ people, onChoose, onClose }: ProfilePickerProps) {
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
        {people.length === 0 ? (
          <p className={styles.empty}>No profiles are set up yet.</p>
        ) : (
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
          </ul>
        )}
      </div>
    </div>
  );
}
