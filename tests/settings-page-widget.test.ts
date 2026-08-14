// src/lib/settings-page/widget.ts — deriving a field's widget from the
// setting's own Zod schema (MILESTONES.md #86: "widgets… all rendered from
// the registry").
//
// The test that matters most is the last describe block: **every key in the
// registry gets a widget, derived, with no per-key table anywhere.** That is
// the property the row is actually about — a hand-written form matching
// today's keys would pass every other test in this file and silently omit
// the twenty-first key the moment somebody adds one.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inputToValue, valueToInput, widgetFor } from "@/lib/settings-page/widget";
import { SETTINGS_REGISTRY, SETTING_KEYS, RETENTION_FLOOR_DAYS } from "@/lib/settings";

describe("shapes derived from the schema", () => {
  it("reads a boolean as a boolean widget", () => {
    expect(widgetFor(z.boolean())).toEqual({ kind: "boolean", nullable: false });
  });

  it("reads an enum as a select, carrying its options in declaration order", () => {
    const widget = widgetFor(z.enum(["never", "allowed", "required"]));
    expect(widget.kind).toBe("enum");
    // Order is the registry's, not re-sorted here — a select that renders
    // alphabetically would move the default away from where its author put it.
    expect(widget.options).toEqual(["never", "allowed", "required"]);
  });

  it("reads a string array as a string list", () => {
    expect(widgetFor(z.array(z.string().min(1))).kind).toBe("string-list");
  });

  it("reads an array of objects as JSON, not as a string list that would mangle it", () => {
    expect(widgetFor(z.array(z.object({ a: z.string() }))).kind).toBe("json");
  });

  it("reads a plain string as text", () => {
    expect(widgetFor(z.string()).kind).toBe("text");
  });

  it("falls back to JSON for a shape it cannot reduce further", () => {
    expect(widgetFor(z.record(z.string(), z.unknown())).kind).toBe("json");
  });
});

describe("number bounds come off the schema, so the input cannot disagree with it", () => {
  it("carries inclusive min and max, and marks an integer", () => {
    const widget = widgetFor(z.number().int().min(1).max(20));
    expect(widget.kind).toBe("number");
    expect(widget.bounds).toEqual({ integer: true, min: 1, max: 20 });
  });

  it("converts an exclusive integer bound to the smallest value the schema accepts", () => {
    // `.positive()` is `> 0`. With `.int()`, the smallest acceptable value is
    // 1 — an input advertising min=0 would offer a value the schema refuses,
    // which is exactly the widget/schema disagreement deriving exists to stop.
    const widget = widgetFor(z.number().int().positive());
    expect(widget.bounds?.min).toBe(1);
    expect(z.number().int().positive().safeParse(0).success).toBe(false);
    expect(z.number().int().positive().safeParse(1).success).toBe(true);
  });

  it("carries a fractional range unchanged", () => {
    expect(widgetFor(z.number().min(0).max(1)).bounds).toEqual({ integer: false, min: 0, max: 1 });
  });

  it("reports no bounds for an unbounded number rather than inventing them", () => {
    const widget = widgetFor(z.number());
    expect(widget.bounds).toEqual({ integer: false });
  });
});

describe("nullability survives the wrappers", () => {
  it("sees through nullable to the inner shape and records that null is legal", () => {
    // Without this, `retention.tool_calls_days` — the one `irreversible`
    // key — would drop to a raw JSON box: the least usable field would be
    // the most dangerous one.
    const widget = widgetFor(z.number().int().min(RETENTION_FLOOR_DAYS).nullable());
    expect(widget.kind).toBe("number");
    expect(widget.nullable).toBe(true);
    expect(widget.bounds?.min).toBe(RETENTION_FLOOR_DAYS);
  });

  it("sees through optional and default too", () => {
    expect(widgetFor(z.boolean().optional()).kind).toBe("boolean");
    expect(widgetFor(z.number().default(3)).kind).toBe("number");
  });

  it("sees through a refinement, which narrows what is accepted without changing the shape", () => {
    const refined = z.string().refine((value) => value.startsWith("/"));
    expect(widgetFor(refined).kind).toBe("text");
  });

  it("marks a non-nullable schema as not nullable", () => {
    expect(widgetFor(z.number()).nullable).toBe(false);
  });
});

describe("rendering a value into an input, and reading it back", () => {
  const numberWidget = widgetFor(z.number().int());
  const listWidget = widgetFor(z.array(z.string()));
  const jsonWidget = widgetFor(z.record(z.string(), z.unknown()));
  const nullableNumber = widgetFor(z.number().nullable());

  it("shows null as empty rather than the word null", () => {
    // A field showing the four characters "null" invites someone to delete
    // them and type a value beside it.
    expect(valueToInput(null, nullableNumber)).toBe("");
  });

  it("shows a string list one entry per line", () => {
    expect(valueToInput(["a", "b"], listWidget)).toBe("a\nb");
  });

  it("shows a JSON value pretty-printed", () => {
    expect(valueToInput({ a: 1 }, jsonWidget)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("reads a number field as a number, not as the string that was typed", () => {
    expect(inputToValue("300", numberWidget)).toEqual({ ok: true, value: 300 });
  });

  it("refuses letters in a number field rather than sending them on as a string", () => {
    const result = inputToValue("abc", numberWidget);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a number");
  });

  it("refuses an empty number field", () => {
    expect(inputToValue("", numberWidget).ok).toBe(false);
  });

  it("reads an empty nullable field as an explicit null", () => {
    // §17.2: JSON null is a legal, meaningful value and is not the same as
    // no row. Clearing a nullable field means "explicitly nothing".
    expect(inputToValue("", nullableNumber)).toEqual({ ok: true, value: null });
  });

  it("reads a string list line by line, dropping the blank lines a textarea leaves", () => {
    expect(inputToValue("a\n\nb\n", listWidget)).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("reads an empty string list as an empty array, not as a list with one empty entry", () => {
    expect(inputToValue("\n  \n", listWidget)).toEqual({ ok: true, value: [] });
  });

  it("refuses malformed JSON rather than sending the text on as a string", () => {
    const result = inputToValue("{not json", jsonWidget);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("valid JSON");
  });

  it("reads a boolean select as a boolean", () => {
    const widget = widgetFor(z.boolean());
    expect(inputToValue("true", widget)).toEqual({ ok: true, value: true });
    expect(inputToValue("false", widget)).toEqual({ ok: true, value: false });
  });

  it("does not itself enforce the bounds — the registry schema is the one arbiter", () => {
    // SCHEMA.md §17.2: "a value has one type, in one place". Parsing decides
    // what the characters mean; the schema decides whether that value is
    // allowed. A bounds check here would be a second place to keep in step.
    const bounded = widgetFor(z.number().int().min(1).max(20));
    expect(inputToValue("999", bounded)).toEqual({ ok: true, value: 999 });
    expect(SETTINGS_REGISTRY["items.max_depth"].schema.safeParse(999).success).toBe(false);
  });
});

describe("every registry key gets a widget, with no per-key table", () => {
  it("derives a widget for every declared key", () => {
    // The whole property row #86 is about. This passes for a key added
    // tomorrow without `widget.ts` being edited — and a hand-written form
    // would fail here the first time somebody added one.
    for (const key of SETTING_KEYS) {
      const widget = widgetFor(SETTINGS_REGISTRY[key].schema);
      expect(widget, key).toBeTruthy();
      expect(typeof widget.kind, key).toBe("string");
    }
  });

  it("round-trips every key's own default through its derived widget", () => {
    // The strongest available check that the derivation is right rather than
    // merely present: render each declared default into its widget's input,
    // read it back, and require the registry's own schema to accept the
    // result. A widget that mis-classified a key would produce a value its
    // schema rejects, and this would fail on that key by name.
    for (const key of SETTING_KEYS) {
      const definition = SETTINGS_REGISTRY[key];
      const widget = widgetFor(definition.schema);
      const rendered = valueToInput(definition.default, widget);
      const parsed = inputToValue(rendered, widget);
      expect(parsed.ok, `${key} parsed back`).toBe(true);
      if (!parsed.ok) continue;
      expect(definition.schema.safeParse(parsed.value).success, `${key} revalidated`).toBe(true);
    }
  });

  it("classifies the registry's keys into more than one widget kind", () => {
    // Guards against the degenerate pass: a `widgetFor` that returned
    // `{ kind: "json" }` for everything would satisfy both tests above.
    const kinds = new Set(SETTING_KEYS.map((key) => widgetFor(SETTINGS_REGISTRY[key].schema).kind));
    expect(kinds.size).toBeGreaterThan(3);
    expect(kinds.has("boolean")).toBe(true);
    expect(kinds.has("number")).toBe(true);
    expect(kinds.has("enum")).toBe(true);
    expect(kinds.has("string-list")).toBe(true);
  });
});
