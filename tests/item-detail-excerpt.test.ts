// `bodyExcerpt` — the prose opening Overview shows as its summary of a
// brief.
//
// The cases below are the shapes this repository's own briefs actually take:
// an `=== BANNER ===` opening, a markdown heading, a fenced code block near
// the top, and a bulleted list. Each one is a way the naive "first three
// lines" version produced a summary that said nothing about the work.
import { describe, expect, it } from "vitest";
import { bodyExcerpt } from "@/lib/item-detail/excerpt";

describe("bodyExcerpt", () => {
  it("skips an `=== BANNER ===` opening and returns the first real sentence", () => {
    // The single-character change this catches: dropping the banner arm of
    // `isStructuralLine`, which would make the excerpt read "=== THE BRIEF
    // ===" — decoration, on every imported item.
    const body = "=== THE BRIEF ===\n\nThe filter region is unusable at narrow widths.\n\nMore.";
    expect(bodyExcerpt(body)).toBe("The filter region is unusable at narrow widths.");
  });

  it("excerpts the sentence UNDER a heading rather than the heading itself", () => {
    // A title restates the item title that is already on screen directly
    // above the excerpt, so returning it would render the same words twice.
    const body = "# Design pass\n\nColour carries no meaning and the scale is bypassed.";
    expect(bodyExcerpt(body)).toBe("Colour carries no meaning and the scale is bypassed.");
  });

  it("skips a leading fenced code block and takes the prose after it", () => {
    const body = "```ts\nconst x = 1;\n```\n\nProse after the fence.";
    expect(bodyExcerpt(body)).toBe("Prose after the fence.");
  });

  it("stops at a fence that follows prose, so code never lands in the summary", () => {
    const body = "The opening sentence.\n```ts\nconst x = 1;\n```";
    expect(bodyExcerpt(body)).toBe("The opening sentence.");
  });

  it("returns empty for a body with no prose at all, rather than inventing one", () => {
    // A brief that is only a code block genuinely has no excerpt. Returning
    // `const x = 1;` here would be worse than rendering nothing, and the
    // caller has a distinct empty state for it.
    expect(bodyExcerpt("```ts\nconst x = 1;\n```")).toBe("");
    expect(bodyExcerpt("")).toBe("");
  });

  it("keeps list text and drops the bullet", () => {
    expect(bodyExcerpt("- First bullet explaining the work\n- second")).toBe(
      "First bullet explaining the work second",
    );
  });

  it("reduces links, emphasis and code spans to their text", () => {
    // Otherwise the excerpt renders raw markdown punctuation — it is
    // plain text by the time it reaches the page, not markdown.
    expect(bodyExcerpt("See [the docs](http://example.com/x) for **why** this `matters`.")).toBe(
      "See the docs for why this matters.",
    );
  });

  it("caps at the limit and cuts on a word boundary", () => {
    const body = "word ".repeat(200);
    const out = bodyExcerpt(body, 50);
    expect(out.length).toBeLessThanOrEqual(51); // 50 plus the ellipsis
    expect(out.endsWith("…")).toBe(true);
    // Cut on a boundary: no half-word before the ellipsis.
    expect(out).toBe("word word word word word word word word word word…");
  });

  it("does not append an ellipsis to a body already under the limit", () => {
    expect(bodyExcerpt("Short enough.", 280)).toBe("Short enough.");
  });
});
