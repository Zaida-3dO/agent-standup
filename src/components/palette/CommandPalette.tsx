"use client";

// The command palette — T18's one entry point for every verb.
//
// Hook-free and prop-driven, like every other view in this tree: the query,
// the selection index and the open flag all live in `PaletteHost`, so this
// component is a plain function a test calls directly with no DOM
// (`tests/helpers/react-element.ts`). See `@/lib/palette/commands`' header
// for why this is written rather than taken from `cmdk`.
import { stateLabel } from "@/lib/palette/commands";
import type { Command } from "@/lib/palette/commands";
import styles from "./CommandPalette.module.css";

export interface CommandPaletteProps {
  /** The commands matching the current query, already filtered. */
  readonly commands: readonly Command[];
  readonly query: string;
  /** Which row is highlighted — an index into `commands`. */
  readonly selectedIndex: number;
  /** What the state verbs will act on, named so the person can see it before pressing Enter. */
  readonly itemLabel: string | null;
  /** A refused command's message — a stale state change is the one that matters. */
  readonly errorMessage: string | null;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (index: number) => void;
  readonly onRun: (command: Command) => void;
  readonly onClose: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
}

/** The id the input points `aria-activedescendant` at. */
function optionId(index: number): string {
  return `palette-option-${index}`;
}

/**
 * The heading a row renders under, or `null` when the row above already has
 * it.
 *
 * Computed by comparison with the previous row rather than by grouping the
 * list into sections, so the flat list stays flat — the selection index and
 * the arrow keys address one sequence of rows, and nesting would make
 * "index 4" require walking groups to resolve.
 */
function headingBefore(commands: readonly Command[], index: number): string | null {
  const group = commands[index]?.group ?? null;
  if (group === null) return null;
  return index === 0 || commands[index - 1]?.group !== group ? group : null;
}

export function CommandPalette({
  commands,
  query,
  selectedIndex,
  itemLabel,
  errorMessage,
  onQueryChange,
  onSelect,
  onRun,
  onClose,
  onKeyDown,
}: CommandPaletteProps) {
  return (
    <div
      className={styles.backdrop}
      // A click on the backdrop closes, matching every other overlay a
      // person has used. Guarded on the target being the backdrop itself so
      // a click that started inside the panel and drifted out does not
      // close a palette mid-interaction.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          className={styles.input}
          type="text"
          value={query}
          autoFocus
          placeholder="Type a command…"
          aria-label="Command"
          // The listbox pattern: the input keeps focus the whole time and
          // announces which option is active, rather than focus moving row
          // to row. Moving focus would take it out of the text field and
          // the next keystroke would stop being a search.
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-options"
          aria-activedescendant={
            commands.length > 0 && commands[selectedIndex] !== undefined
              ? optionId(selectedIndex)
              : undefined
          }
          onChange={(event) => onQueryChange(event.target.value)}
        />

        {itemLabel !== null && (
          // Which item the state verbs act on. Without this the palette
          // offers "Change state to merged" with no statement of what will
          // be merged, which is a destructive-shaped action taken on trust.
          <p className={styles.context}>
            Acting on <span className={styles.contextItem}>{itemLabel}</span>
          </p>
        )}

        {errorMessage !== null && (
          <p className={styles.error} role="alert">
            {errorMessage}
          </p>
        )}

        {commands.length === 0 ? (
          <p className={styles.empty}>No commands match “{query}”.</p>
        ) : (
          <ul className={styles.list} id="palette-options" role="listbox" aria-label="Commands">
            {commands.map((command, index) => {
              const heading = headingBefore(commands, index);
              return (
                <li key={command.id} className={styles.row}>
                  {heading !== null && (
                    // Presentational: the heading is inside the list for
                    // layout, but a listbox whose children include
                    // non-options is malformed, so it is marked out of the
                    // accessibility tree and the option below carries the
                    // group name in its own label instead.
                    <p className={styles.groupHeading} role="presentation">
                      {heading}
                    </p>
                  )}
                  <button
                    type="button"
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={index === selectedIndex ? styles.optionSelected : styles.option}
                    // `tabIndex={-1}` because focus stays in the input —
                    // see the combobox note above. The row is still a real
                    // button so a click works and so the accessible name
                    // comes from its text.
                    tabIndex={-1}
                    // `onMouseMove` rather than `onMouseEnter`: the mouse
                    // sitting still under a row that moved when the list
                    // re-filtered would otherwise steal the selection from
                    // the keyboard.
                    onMouseMove={() => onSelect(index)}
                    onClick={() => onRun(command)}
                  >
                    <span className={styles.optionLabel}>{command.label}</span>
                    {command.intent.kind === "change-state" && (
                      <span className={styles.optionMeta}>{stateLabel(command.intent.to)}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className={styles.footer}>
          <kbd className={styles.key}>↑</kbd>
          <kbd className={styles.key}>↓</kbd> to move · <kbd className={styles.key}>Enter</kbd> to
          run · <kbd className={styles.key}>Esc</kbd> to close · <kbd className={styles.key}>?</kbd>{" "}
          for all shortcuts
        </p>
      </div>
    </div>
  );
}
