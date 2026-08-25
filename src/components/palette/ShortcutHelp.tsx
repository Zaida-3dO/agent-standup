"use client";

// The `?` help sheet — T18's answer to "an undiscoverable shortcut set is
// worth very little".
//
// Renders `SHORTCUTS` directly. It holds no list of its own, which is the
// whole point: a sheet with its own hand-written table would be a second
// copy of the registry, and the first shortcut added without updating it
// would work while being undocumented — the exact failure the row names.
//
// Hook-free and prop-driven, like the palette beside it.
import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutsInGroup,
  type Shortcut,
} from "@/lib/palette/shortcuts";
import styles from "./ShortcutHelp.module.css";

export interface ShortcutHelpProps {
  readonly onClose: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
  /** Injected only by tests that need a known table; production renders the real registry. */
  readonly shortcuts?: readonly Shortcut[];
}

export function ShortcutHelp({ onClose, onKeyDown, shortcuts = SHORTCUTS }: ShortcutHelpProps) {
  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={onKeyDown}
      >
        <div className={styles.header}>
          <h2 className={styles.heading}>Keyboard shortcuts</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            autoFocus
            aria-label="Close keyboard shortcuts"
          >
            Close
          </button>
        </div>

        {SHORTCUT_GROUPS.map((group) => {
          const inGroup = shortcutsInGroup(group, shortcuts);
          // A group with nothing in it renders nothing rather than an empty
          // heading — the registry decides what exists, not this list.
          if (inGroup.length === 0) return null;
          return (
            <section key={group} className={styles.group}>
              <h3 className={styles.groupHeading}>{group}</h3>
              <dl className={styles.list}>
                {inGroup.map((shortcut) => (
                  <div key={shortcut.id} className={styles.entry}>
                    <dt className={styles.keys}>
                      {shortcut.keys.map((key, index) => (
                        <kbd key={`${shortcut.id}-${index}`} className={styles.key}>
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd className={styles.label}>{shortcut.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}

        <p className={styles.note}>
          Single-key shortcuts are ignored while you are typing in a field.
        </p>
      </div>
    </div>
  );
}
