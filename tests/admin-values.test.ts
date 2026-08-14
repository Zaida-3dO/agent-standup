// src/lib/admin/values.ts — rendering an entity's values into a form and
// reading them back (MILESTONES.md #93).
//
// This module deliberately does **not** validate: the #92 operations do, with
// the settings registry's own validator for the override columns (§17.7) and
// the registered-adapter list for a vendor. So the tests below check that it
// assigns the right *meaning* to characters and passes everything else on —
// including values the service will refuse, because a client-side second
// opinion about them is the thing that drifts.
import { describe, expect, it } from "vitest";
import { adminKindBySlug } from "@/lib/admin/kinds";
import { fromInput, toCell, toInput } from "@/lib/admin/values";

const repos = adminKindBySlug("repos")!;
const machines = adminKindBySlug("machines")!;
const accounts = adminKindBySlug("accounts")!;

const host = repos.fields.find((f) => f.name === "host")!;
const needsVisualReview = repos.fields.find((f) => f.name === "needsVisualReview")!;
const planType = accounts.fields.find((f) => f.name === "planType")!;
const sourceGlobs = machines.fields.find((f) => f.name === "sourceGlobs")!;
const budgetWindows = accounts.fields.find((f) => f.name === "budgetWindows")!;

describe("rendering a stored value into its input", () => {
  it("shows null as empty rather than the word null", () => {
    expect(toInput(null, host)).toBe("");
    expect(toInput(undefined, host)).toBe("");
  });

  it("shows a list one entry per line, so nobody types array syntax", () => {
    expect(toInput(["a/**", "b/**"], sourceGlobs)).toBe("a/**\nb/**");
  });

  it("shows a JSON document pretty-printed", () => {
    expect(toInput({ w5h: {} }, budgetWindows)).toBe(JSON.stringify({ w5h: {} }, null, 2));
  });

  it("shows a boolean as true or false", () => {
    expect(toInput(true, needsVisualReview)).toBe("true");
    expect(toInput(false, needsVisualReview)).toBe("false");
  });

  it("shows a plain string as itself", () => {
    expect(toInput("git.example", host)).toBe("git.example");
  });
});

describe("reading an input back", () => {
  it("reads a boolean select as a boolean", () => {
    expect(fromInput("true", needsVisualReview)).toEqual({ ok: true, value: true });
    expect(fromInput("false", needsVisualReview)).toEqual({ ok: true, value: false });
  });

  it("reads a list line by line, dropping the blank lines a textarea leaves", () => {
    expect(fromInput("a/**\n\nb/**\n", sourceGlobs)).toEqual({ ok: true, value: ["a/**", "b/**"] });
  });

  it("reads an emptied list as an empty array — an override that matches nothing", () => {
    // Not null. Clearing the *text* is different from choosing to inherit,
    // which the editor offers as its own control (§17.7, §23.2).
    expect(fromInput("", sourceGlobs)).toEqual({ ok: true, value: [] });
    expect(fromInput("   \n  ", sourceGlobs)).toEqual({ ok: true, value: [] });
  });

  it("reads an emptied optional text field as null, which is how the API spells cleared", () => {
    // `host` is `.nullable().optional()`; sending "" would hit `.min(1)` and
    // be refused with a message about length nobody typed a length for.
    expect(fromInput("", host)).toEqual({ ok: true, value: null });
    expect(fromInput("   ", host)).toEqual({ ok: true, value: null });
  });

  it("trims a text field, so a stray space does not become part of the value", () => {
    expect(fromInput("  git.example  ", host)).toEqual({ ok: true, value: "git.example" });
  });

  it("refuses malformed JSON rather than sending the text on as a string", () => {
    const result = fromInput("{not json", budgetWindows);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("valid JSON");
  });

  it("refuses an empty JSON field", () => {
    expect(fromInput("   ", budgetWindows).ok).toBe(false);
  });

  it("passes a value the service will refuse straight through, unjudged", () => {
    // The vendor check lives in `update_account` against the registered
    // adapter list. A second opinion here would be a second thing to keep
    // in step, and the message a person sees should be the service's own.
    const vendor = accounts.fields.find((f) => f.name === "vendor")!;
    expect(fromInput("not-a-real-vendor", vendor)).toEqual({
      ok: true,
      value: "not-a-real-vendor",
    });
  });

  it("reads an enum value as the string it is", () => {
    expect(fromInput("metered", planType)).toEqual({ ok: true, value: "metered" });
  });
});

describe("what a list cell shows", () => {
  it("says Inheriting for an unset override, and a dash for any other unset field", () => {
    expect(toCell(null, sourceGlobs)).toBe("Inheriting");
    expect(toCell(null, host)).toBe("—");
  });

  it("counts a list rather than printing it, so one row cannot fill the screen", () => {
    expect(toCell(["a", "b", "c"], sourceGlobs)).toBe("3 entries");
    expect(toCell(["a"], sourceGlobs)).toBe("1 entry");
  });

  it("distinguishes an empty override from an unset one", () => {
    // Both would read as "nothing" under a naive renderer, and they are
    // opposite instructions.
    expect(toCell([], sourceGlobs)).toBe("(empty)");
    expect(toCell(null, sourceGlobs)).toBe("Inheriting");
  });

  it("says set for a document rather than dumping it", () => {
    expect(toCell({ w5h: {} }, budgetWindows)).toBe("set");
  });

  it("says yes or no for a boolean", () => {
    expect(toCell(true, needsVisualReview)).toBe("yes");
    expect(toCell(false, needsVisualReview)).toBe("no");
  });

  it("shows a scalar as itself", () => {
    expect(toCell("git.example", host)).toBe("git.example");
    expect(toCell(3, host)).toBe("3");
  });
});
