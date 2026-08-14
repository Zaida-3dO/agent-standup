// Deriving a field's widget from the setting's own schema — MILESTONES.md
// #86: "categories, widgets, per-field help and validation **all rendered
// from the registry**", and SCHEMA.md §17.2's second property: "The editing
// surfaces are generated, not maintained."
//
// **The whole point is that there is no per-key table here.** A hand-written
// form that happens to match today's twenty keys is the failure mode this
// module exists to prevent: it stays green, and it silently omits the
// twenty-first the moment somebody adds one. Everything below is a function
// of the Zod schema the registry already declares, so a new key gets a
// widget without this file being edited — and `settingsPageModel` renders
// `SETTING_KEYS` in full, so a key it could not classify appears as a JSON
// field rather than disappearing.
//
// Pure functions over plain data, no DOM: this repo's harness runs
// `environment: "node"` (`vitest.config.ts`), so the derivation is exercised
// directly rather than through a rendered component — the same split
// `src/lib/board/view.ts` follows.
import { z } from "zod";

/**
 * The widget kinds the page can draw.
 *
 * Deliberately few. Each is a *shape* — a boolean, a bounded number, a
 * closed set, a list of strings, an arbitrary JSON document — not a setting.
 * `json` is the honest fallback for a schema whose shape this module cannot
 * reduce further (`budget.windows` is a nested map with its own editor in
 * row #87), and it is fully functional rather than a placeholder: the value
 * is still validated on write by the same registry schema.
 */
export type WidgetKind = "boolean" | "number" | "enum" | "string-list" | "text" | "json";

export interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
}

export interface Widget {
  readonly kind: WidgetKind;
  /** For `enum` — the permitted values, in declaration order. */
  readonly options?: readonly string[];
  /** For `number` — the bounds the schema itself carries, so the input can enforce them too. */
  readonly bounds?: NumberBounds;
  /**
   * Whether the schema accepts `null` as a value. Drives the "explicitly
   * nothing" affordance §17.2 calls for: JSON `null` is a legal, meaningful
   * value ("notifications off", "keep forever") and is not the same as no
   * row, so a nullable field needs a way to say null that is distinct from
   * clearing the override.
   */
  readonly nullable: boolean;
}

/**
 * Unwraps the wrappers that do not change a schema's *shape*, recording
 * nullability on the way.
 *
 * `z.number().nullable()` is a `ZodNullable` around a `ZodNumber`: the field
 * is still a number input, it just also accepts null. Reading the wrapper as
 * an unclassifiable shape — which is what happens without this — would drop
 * `retention.tool_calls_days` to a raw JSON box, and that key is the
 * `irreversible` one, so the least usable field would be the most dangerous.
 */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; nullable: boolean } {
  let current = schema;
  let nullable = false;
  // Bounded rather than `while (true)`: a self-referential schema would
  // otherwise spin here, and a widget derivation is not the place to hang a
  // page render. Ten is far past any nesting the registry has or wants.
  for (let depth = 0; depth < 10; depth++) {
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      // A `.refine()`/`.transform()` wrapper narrows what is *accepted*
      // without changing the shape a person edits, so the widget is the
      // inner schema's. The refinement still runs on write — it lives in the
      // registry schema, which is what validates the value server-side.
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return { inner: current, nullable };
}

/**
 * Reads the `min`/`max`/integer facts a `ZodNumber` already carries, so the
 * input can mirror them.
 *
 * **The bounds reported are what the schema will actually accept**, which
 * means an exclusive check has to be converted rather than passed through:
 * `.positive()` is `> 0`, and combined with `.int()` the smallest acceptable
 * value is 1, not 0. An input advertising `min=0` on a key whose schema
 * refuses 0 would present a value the field says is fine and the server
 * rejects — the exact disagreement between widget and schema that deriving
 * from the schema exists to remove. For a non-integer there is no
 * representable smallest value above an exclusive bound, so the bound is
 * carried as-is and the schema stays the arbiter.
 */
function numberBounds(schema: z.ZodNumber): NumberBounds {
  const checks = schema._def.checks ?? [];
  const integer = checks.some((check) => check.kind === "int");

  let min: number | undefined;
  let max: number | undefined;
  for (const check of checks) {
    if (check.kind === "min") {
      const lower = check.inclusive ? check.value : integer ? check.value + 1 : check.value;
      min = min === undefined ? lower : Math.max(min, lower);
    } else if (check.kind === "max") {
      const upper = check.inclusive ? check.value : integer ? check.value - 1 : check.value;
      max = max === undefined ? upper : Math.min(max, upper);
    }
  }

  return { integer, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

/**
 * The widget for one setting, derived from its schema alone.
 *
 * Order matters only in that the more specific shapes are tested first; the
 * final `json` is reached by anything this module cannot reduce, which is a
 * deliberate outcome and not a gap. A shape it does not know still renders,
 * still validates on write against its own schema, and still shows its help.
 */
export function widgetFor(schema: z.ZodTypeAny): Widget {
  const { inner, nullable } = unwrap(schema);

  if (inner instanceof z.ZodBoolean) return { kind: "boolean", nullable };

  if (inner instanceof z.ZodNumber) {
    return { kind: "number", bounds: numberBounds(inner), nullable };
  }

  if (inner instanceof z.ZodEnum) {
    // `.options` is the declared members, in declaration order — which is
    // the order the select renders them in, so the registry decides the
    // order rather than this module re-sorting it.
    return { kind: "enum", options: inner.options as readonly string[], nullable };
  }

  if (inner instanceof z.ZodArray) {
    const element = unwrap(inner.element as z.ZodTypeAny).inner;
    // A list of plain strings is a widget anyone can use; a list of objects
    // is not, and is better served by the JSON field than by a string list
    // that would silently mangle it.
    if (element instanceof z.ZodString) return { kind: "string-list", nullable };
    return { kind: "json", nullable };
  }

  if (inner instanceof z.ZodString) return { kind: "text", nullable };

  return { kind: "json", nullable };
}

/**
 * Renders a value into the string a text-shaped input shows.
 *
 * `null` renders as the empty string rather than the four characters
 * `null`, because a field showing the word "null" invites someone to delete
 * it and type a value beside it. Whether the field means null is carried by
 * the nullable affordance, not by its text.
 */
export function valueToInput(value: unknown, widget: Widget): string {
  if (value === null || value === undefined) return "";
  if (widget.kind === "string-list") {
    return Array.isArray(value) ? value.join("\n") : JSON.stringify(value, null, 2);
  }
  if (widget.kind === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** What a field's raw input parses to before the registry schema sees it. */
export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Turns what a person typed into the value to send.
 *
 * **This does not validate.** Parsing and validating are deliberately
 * separate: this decides what the characters *mean* (the text `3` in a
 * number field means the number three), and the registry's own schema
 * decides whether that value is allowed — SCHEMA.md §17.2, "a value has one
 * type, in one place". A second bounds check here would be a second place.
 *
 * The one thing it does refuse is input it cannot assign a meaning to at
 * all: letters in a number field, malformed JSON. Sending those on as a
 * string would make the server reject them with a type error about a shape
 * nobody typed.
 */
export function inputToValue(raw: string, widget: Widget): ParseResult {
  if (widget.kind === "boolean") return { ok: true, value: raw === "true" };

  if (widget.nullable && raw.trim() === "") return { ok: true, value: null };

  switch (widget.kind) {
    case "number": {
      if (raw.trim() === "") return { ok: false, error: "Enter a number." };
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return { ok: false, error: `${raw} is not a number.` };
      return { ok: true, value: parsed };
    }
    case "string-list": {
      // One entry per line, blank lines dropped — a trailing newline is how
      // a textarea ends, not an empty glob somebody meant to add.
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
    default:
      return { ok: true, value: raw };
  }
}
