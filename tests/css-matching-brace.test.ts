// The shared brace walk every stylesheet-parsing test now depends on.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// `matchingBrace` is the single point of failure for every CSS assertion in
// the suite, so its contract is tested directly here rather than only
// through the four test files that call it. A caller can only exercise the
// shapes its own stylesheet happens to contain, and the hazards this walk
// exists to handle — a brace inside a quoted string, an unclosed block —
// need appear in no stylesheet at all for the walk to be wrong about them.
// Tested only through callers, it would be free to mishandle exactly the
// cases it was written for while every one of those callers stayed green.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting the `if (ch === '"' || ch === "'") quote = ch;` branch makes
//     every quoted-brace test fail, because braces in strings resume
//     counting as structure.
//   - Deleting the `if (ch === "\\") i += 1;` escape branch fails the
//     escaped-quote tests: the string is treated as closing early, so the
//     brace after it is miscounted.
//   - Changing the final `throw` to `return source.length` fails every
//     unterminated test — that substitution is what turns an unclosed
//     block into a silent slice to end of file.
//   - Changing `if (depth === 0) return i` to `return i + 1` or `i - 1`
//     fails the index tests, which assert the returned character IS `}`.
//   - Deleting the opening `source[openIndex] !== "{"` guard fails the
//     rejects-a-non-brace tests.
import { describe, expect, it } from "vitest";
import { matchingBrace } from "./helpers/css-blocks";

/** The index of the `{` in a fixture, for readability at the call sites. */
function firstOpen(css: string): number {
  return css.indexOf("{");
}

describe("matchingBrace", () => {
  it("finds the closing brace of a flat block", () => {
    const css = ".a { color: red; }";
    const close = matchingBrace(css, firstOpen(css));
    expect(css[close]).toBe("}");
    expect(close).toBe(css.length - 1);
  });

  it("skips a nested block and returns the OUTER closing brace", () => {
    // The media-query shape every caller actually uses.
    const css = "@media (max-width: 640px) {\n  .a { color: red; }\n}\n.b { color: blue; }";
    const close = matchingBrace(css, firstOpen(css));
    expect(css[close]).toBe("}");
    // The rule after the block must NOT be inside the returned span — this
    // is the absorption failure the extraction was made to stop.
    expect(css.slice(0, close)).not.toContain(".b");
    expect(css.slice(close)).toContain(".b");
  });

  it("handles several levels of nesting", () => {
    const css = "@supports (a: b) { @media (c) { .d { e: f; } } } .after {}";
    const close = matchingBrace(css, firstOpen(css));
    expect(css.slice(0, close)).not.toContain(".after");
  });

  // ── Quoted braces: the defect this extraction exists to fix ──────────

  it("does not count an opening brace inside a double-quoted string", () => {
    // Without quote-awareness the `{` inflates depth, the walk runs PAST
    // the real closing brace, and `.after` is absorbed into the block.
    const css = '@media (max-width: 640px) { .a { content: "{"; } }\n.after { x: y; }';
    const close = matchingBrace(css, firstOpen(css));
    expect(css.slice(0, close)).not.toContain(".after");
  });

  it("does not count a closing brace inside a double-quoted string", () => {
    // The mirror case: without quote-awareness the block ends early and
    // every later declaration in it is silently dropped.
    const css = '@media (max-width: 640px) { .a { content: "}"; } .b { min-height: 44px; } }';
    const close = matchingBrace(css, firstOpen(css));
    expect(close).toBe(css.length - 1);
    expect(css.slice(0, close)).toContain("min-height: 44px");
  });

  it("does not count braces inside a single-quoted string", () => {
    const css = "@media (x) { .a { content: '{'; } }\n.after { x: y; }";
    const close = matchingBrace(css, firstOpen(css));
    expect(css.slice(0, close)).not.toContain(".after");
  });

  it("treats a quote of the other style inside a string as ordinary text", () => {
    // A `'` inside a double-quoted string must not close it, or the `}`
    // that follows would be counted as structure.
    const css = '@media (x) { .a { content: "it\'s }"; } .b { c: d; } }';
    const close = matchingBrace(css, firstOpen(css));
    expect(close).toBe(css.length - 1);
    expect(css.slice(0, close)).toContain(".b");
  });

  it("does not let an escaped quote close the string", () => {
    // `content: "\"}"` — the escaped quote keeps the string open, so the
    // `}` inside it is still text, not structure.
    const css = '@media (x) { .a { content: "\\"}"; } .b { c: d; } }';
    const close = matchingBrace(css, firstOpen(css));
    expect(close).toBe(css.length - 1);
    expect(css.slice(0, close)).toContain(".b");
  });

  it("does not let an escaped backslash swallow the closing quote", () => {
    // `content: "\\"` is a string holding one backslash, and it CLOSES.
    // If the escape branch consumed the closing quote instead, the rest of
    // the sheet would be read as string content and the walk would run off
    // the end.
    const css = '@media (x) { .a { content: "\\\\"; } .b { c: d; } }';
    const close = matchingBrace(css, firstOpen(css));
    expect(close).toBe(css.length - 1);
    expect(css.slice(0, close)).toContain(".b");
  });

  // ── Malformed input THROWS rather than slicing to end of file ────────

  it("throws when the block is never closed", () => {
    const css = "@media (max-width: 640px) { .a { color: red; }";
    expect(() => matchingBrace(css, firstOpen(css))).toThrow(/never closed/);
  });

  it("closes a block ending at end of file whose only extra brace is quoted", () => {
    // The inflation case with nothing after the block. This sheet is
    // perfectly well-formed — the `{` is string content — so the contract
    // is to CLOSE it correctly, not to throw. A depth counter that counted
    // the quoted brace would run off the end here and report an
    // "unterminated block" for a sheet that is not malformed at all: a
    // false FAILURE rather than a false pass. Which of the two a
    // quote-unaware walk produces depends only on whether the block
    // happens to be the last thing in its file, which is why neither
    // outcome is evidence the walk is sound.
    const css = '@media (x) { .a { content: "{"; } }';
    const close = matchingBrace(css, firstOpen(css));
    expect(close).toBe(css.length - 1);
  });

  it("reports the depth it reached, so a malformed sheet is diagnosable", () => {
    const css = "@media (x) { .a { .b {";
    expect(() => matchingBrace(css, firstOpen(css))).toThrow(/depth 3/);
  });

  it("rejects an index that is not an opening brace", () => {
    const css = ".a { color: red; }";
    expect(() => matchingBrace(css, 0)).toThrow(/not `\{`/);
  });

  it("rejects an index outside the source", () => {
    const css = ".a { color: red; }";
    expect(() => matchingBrace(css, css.length + 5)).toThrow(/outside the source/);
    expect(() => matchingBrace(css, -1)).toThrow(/outside the source/);
  });

  it("terminates on a pathological sheet rather than hanging", () => {
    // Bounded by source length: an unclosed block a megabyte long fails
    // fast instead of spinning. The assertion is that it returns at all.
    const css = "@media (x) {" + " ".repeat(200_000);
    const started = Date.now();
    expect(() => matchingBrace(css, firstOpen(css))).toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
