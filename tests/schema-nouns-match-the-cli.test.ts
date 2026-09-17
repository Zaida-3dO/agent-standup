// SCHEMA.md §20's noun list against the command table it describes.
//
// ── Why this test exists ────────────────────────────────────────────────
//
// §20 named nine nouns while the table carried sixteen. Nothing detected
// that, because a document and a table drift apart silently: both read as
// correct in isolation, and the only reader who notices is one who trusts
// the document.
//
// **That reader is the hazard.** An agent or a contributor treating §20 as
// normative has a way to go wrong that mere untidiness does not — they
// "fix" the code to match the document and delete working commands. The
// document being right is what closes that path.
//
// So this compares the two directly, and the assertion is EQUALITY rather
// than containment in either direction: a noun in the code and not the
// document is the drift that already happened, and a noun in the document
// and not the code is the instruction to delete something that works.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { nouns } from "@/lib/cli/commands";

const SCHEMA = path.resolve(process.cwd(), "docs", "plans", "SCHEMA.md");

/**
 * The nouns §20's Shape paragraph lists.
 *
 * Read from the document rather than from a copy kept here, for the reason
 * this file exists: a third list would drift from both the other two, and
 * would do it silently.
 */
function documentedNouns(): string[] {
  const source = readFileSync(SCHEMA, "utf-8");
  const marker = "**Shape.** `standup <noun> <verb>`, nouns ";
  const start = source.indexOf(marker);
  expect(start, "SCHEMA.md §20 should carry a Shape paragraph naming the nouns").toBeGreaterThan(
    -1,
  );
  // The list runs to ", plus", which introduces the standalone words —
  // `init`, `doctor`, `hook`, `mcp` — that are not `<noun> <verb>` pairs and
  // so are not in the command table at all.
  const after = source.slice(start + marker.length);
  const end = after.indexOf(", plus");
  expect(end, "the noun list should end at `, plus`").toBeGreaterThan(-1);
  return [...after.slice(0, end).matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!);
}

describe("SCHEMA.md §20 lists exactly the nouns the command table binds", () => {
  it("names every noun a person can type, and no noun they cannot", () => {
    // Sorted on both sides so the comparison is about membership rather than
    // the order the document happens to read well in.
    expect([...documentedNouns()].sort()).toEqual([...nouns()].sort());
  });

  it("lists them without duplicates", () => {
    const documented = documentedNouns();
    expect(documented).toEqual([...new Set(documented)]);
  });

  it("names the two nouns that are spelled the same on MCP", () => {
    // `loop` and `score` each name one capability on both surfaces. This is
    // the property the taxonomy actually wants, so it is pinned rather than
    // left as a coincidence that a later rename could undo quietly.
    const documented = documentedNouns();
    expect(documented).toContain("loop");
    expect(documented).toContain("score");
  });
});
