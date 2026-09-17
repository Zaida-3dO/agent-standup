// A short, plain-text opening from a markdown brief — what Overview shows
// instead of the whole document.
//
// **Why an excerpt rather than a CSS line-clamp.** A clamp still renders
// every code block, table and heading into the page and then hides the
// overflow: the cost is unchanged, the whole text is still in the
// accessibility tree and in a page search, and what a reader sees cut off
// mid-token is whatever the first three lines happened to be — frequently a
// fenced code block or a `===` banner, which says nothing about the work.
// Taking prose only, in code, is what makes the summary a summary.
//
// Pure and dependency-free so it can be asserted directly, like the rest of
// `src/lib`.

/**
 * Lines that carry no summary value on their own. Each is dropped BEFORE the
 * first paragraph is chosen, so a brief opening with a banner or a fence
 * still yields its first real sentence rather than the decoration above it.
 */
function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  // A setext underline or a horizontal rule — `---`, `===`, `***`.
  if (/^[-=*_]{3,}$/.test(trimmed)) return true;
  // An `=== SECTION ===` banner, the convention these briefs use.
  if (/^=+.*=+$/.test(trimmed)) return true;
  // A table row or an HTML comment.
  if (trimmed.startsWith("|") || trimmed.startsWith("<!--")) return true;
  return false;
}

/** Inline markdown emphasis, links and code spans, reduced to their text. */
function stripInline(text: string): string {
  return (
    text
      // A link or image: keep the label, drop the target.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Code spans, bold, italic, strikethrough.
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The first paragraph of a markdown body as plain text, capped at `limit`
 * characters and cut on a word boundary.
 *
 * Returns an empty string when the body has no prose at all — a brief that
 * is nothing but a code block genuinely has no excerpt, and inventing one
 * from its first line of source would be worse than showing none. The
 * caller decides what to render in that case.
 *
 * Fenced code blocks are skipped wholesale rather than having their fence
 * markers stripped: the content of a fence is not prose, and its first line
 * is typically an import or a shell command.
 */
export function bodyExcerpt(body: string, limit = 280): string {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      // A fence that opens after prose has begun ends the paragraph.
      if (inFence && collected.length > 0) break;
      continue;
    }
    if (inFence) continue;

    if (isStructuralLine(line)) {
      // A blank line ends the first paragraph once one has started;
      // before that it is just leading space.
      if (collected.length > 0) break;
      continue;
    }

    // A heading contributes its text but does not, alone, make a
    // paragraph — a brief that opens with a title should excerpt the
    // sentence under it, not the title.
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (collected.length > 0) break;
      continue;
    }

    // A list marker or block quote keeps its text and loses its bullet.
    collected.push(line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, ""));
  }

  const text = stripInline(collected.join(" "));
  if (text.length <= limit) return text;

  // Cut on a word boundary so the excerpt does not end mid-word. Falls back
  // to a hard cut for text with no spaces in it at all.
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
