// Rendering an entity's values into a form, and reading them back —
// MILESTONES.md #93.
//
// Deliberately the same split as the settings page: this module decides what
// the characters *mean*, and the service operations #92 delivered decide
// whether the value is *allowed*. `update_machine` validates `sourceGlobs`
// with the settings registry's own validator (§17.7) and `update_account`
// checks `vendor` against the registered adapter list — neither rule is
// copied here, because a copy is a second thing to keep in step and the one
// furthest from the database is the one that drifts.
import type { AdminField } from "./kinds";

/** What a value looks like in its input. */
export function toInput(value: unknown, field: AdminField): string {
  if (value === null || value === undefined) return "";
  switch (field.kind) {
    case "string-list":
      // One entry per line, so a list is editable without anyone writing
      // JSON array syntax by hand.
      return Array.isArray(value) ? value.join("\n") : JSON.stringify(value, null, 2);
    case "json":
      return JSON.stringify(value, null, 2);
    case "boolean":
      return value === true ? "true" : "false";
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Turns what a person typed into the value to send.
 *
 * Refuses only input it cannot assign a meaning to at all — malformed JSON.
 * Everything else is passed on for the service to accept or refuse, so the
 * message a person sees about a value is the service's own sentence about
 * it rather than this layer's guess at what the service would say.
 */
export function fromInput(raw: string, field: AdminField): ParseResult {
  switch (field.kind) {
    case "boolean":
      return { ok: true, value: raw === "true" };
    case "string-list": {
      // Blank lines dropped: a trailing newline is how a textarea ends, not
      // an empty glob somebody meant to add.
      const entries = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return { ok: true, value: entries };
    }
    case "json": {
      if (raw.trim() === "") return { ok: false, error: "Enter a JSON value." };
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false, error: "That is not valid JSON." };
      }
    }
    default: {
      const trimmed = raw.trim();
      // An emptied optional text field means "clear it". The #92 schemas
      // spell a cleared optional as `null` (`host` is
      // `.nullable().optional()`), so an empty box becomes `null` rather
      // than the empty string — which those schemas' `.min(1)` would refuse
      // with a message about length that nobody typed a length for.
      return { ok: true, value: trimmed === "" ? null : trimmed };
    }
  }
}

/**
 * What a row shows in a list cell.
 *
 * Compact rather than complete: a list is scanned, and a nested budget-window
 * document rendered in full would push every other column off the screen.
 * The editor shows the whole value.
 */
export function toCell(value: unknown, field: AdminField): string {
  if (value === null || value === undefined) {
    return field.overridesSetting ? "Inheriting" : "—";
  }
  if (field.kind === "boolean") return value === true ? "yes" : "no";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  }
  if (typeof value === "object") return "set";
  return String(value);
}
