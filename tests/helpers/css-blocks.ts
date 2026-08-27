// The one brace walk shared by every stylesheet-parsing test.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// Finding a CSS block's closing `}` is needed by four separate test files,
// and it is a walk with one non-obvious rule in it: a brace inside a
// quoted string is text, not structure. That rule is easy to omit, and
// omitting it does not fail — it makes a stylesheet assertion read the
// wrong span of the file and report a result anyway. Written out at each
// call site, the rule has to be remembered five times and gets checked
// nowhere; written here once, it is stated in a single place, tested
// directly in `tests/css-matching-brace.test.ts`, and inherited by every
// caller that needs it.
//
// ── What is shared and what is deliberately NOT ─────────────────────────
//
// **Only the walk is here.** The five callers also differ in how they
// match a prelude, how many blocks they tolerate, and whether a violation
// throws or fails an `expect()` — and those differences are real:
// `board-filter-bar-keyboard-path.test.ts` and
// `board-header-touch-targets.test.ts` tolerate MULTIPLE blocks sharing a
// breakpoint because their stylesheets genuinely split it across separate
// edits, while `board-list-view-density.test.ts` and
// `standup-touch-targets.test.ts` require exactly one because a split IS
// the drift those files exist to catch. A shared helper that picked one
// policy would take that detection away from the two files built on it.
// So each caller keeps its own cardinality rule and its own error style,
// and imports only the character-level walk they all agreed on anyway.

/**
 * The index of the `}` that closes the `{` at `openIndex`.
 *
 * **Input contract.** `source` is CSS text and `source[openIndex]` must be
 * `{` — the caller has already located the opening brace of the block it
 * wants (usually just past a prelude it matched itself). Passing an index
 * that is not `{` is a programming error in the caller and throws
 * immediately rather than walking from a meaningless position.
 *
 * **Quoted strings do not contain braces.** `content: "{"` and
 * `content: "}"` are ordinary CSS, and a plain depth counter reads both as
 * structure. Counting a quoted `{` inflates the depth so the walk runs
 * PAST the block's real closing brace and absorbs whatever follows —
 * unconditional rules get reported as if they were declared inside a media
 * query, which makes a breakpoint assertion pass against a stylesheet that
 * never raised the rule at that breakpoint. Counting a quoted `}` is the
 * mirror: the block ends early and every declaration after it silently
 * disappears. Both quote styles are handled, and a backslash escape
 * (`content: "\""`) does not close the string.
 *
 * **On malformed input it THROWS.** Reaching the end of `source` with
 * depth still above zero means the block is never closed, and there is no
 * useful answer to return: a slice to end-of-file would hand the caller
 * the entire rest of the stylesheet as if it were the block's body, and
 * every assertion made against it would then be reading declarations from
 * outside the block it claims to be testing. Failing the run is the only
 * answer that cannot be mistaken for a result.
 *
 * **It terminates.** The walk is bounded by `source.length` and advances
 * on every iteration, so a malformed sheet fails in microseconds rather
 * than hanging the run.
 *
 * Comments are NOT handled, because every caller strips them from the
 * source before parsing. A CSS comment containing a brace would be
 * miscounted if one did not — which is why that stripping is the caller's
 * documented first step and not an optional convenience.
 *
 * @param source     CSS text, comments already stripped.
 * @param openIndex  Index of the block's opening `{`.
 * @returns          Index of the matching `}`.
 * @throws           If `source[openIndex]` is not `{`, or the block is
 *                   never closed before the end of `source`.
 */
export function matchingBrace(source: string, openIndex: number): number {
  if (source[openIndex] !== "{") {
    throw new Error(
      `matchingBrace: index ${openIndex} is ${
        openIndex < 0 || openIndex >= source.length
          ? "outside the source"
          : `\`${source[openIndex]}\`, not \`{\``
      }.`,
    );
  }
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      // Inside a string: nothing counts as a brace until the matching
      // quote closes it, and an escaped quote (`\"`) does not close it.
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(
    `Block opening at index ${openIndex} is never closed ` +
      `(reached end of source with depth ${depth}).`,
  );
}
