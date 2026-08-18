// Renders a stored body as markdown — headings, GFM tables, code, lists
// and links.
//
// ── Why this exists ────────────────────────────────────────────────────
//
// Every item carries a full markdown brief, and a brief shown as plain text
// puts its `##` and its pipe tables on screen as literal characters. A
// table is the case that fails worst: read as text it is a wall of pipes
// with no column alignment at all, so the structure that made the author
// choose a table is exactly what the reader loses.
//
// ── Why it is safe ─────────────────────────────────────────────────────
//
// Bodies are written by agents and stored, so this is a stored-content
// render path and the input is not trusted. Two things make that safe, and
// they are different in kind:
//
// 1. **No HTML is parsed.** `react-markdown` builds React elements from the
//    markdown syntax tree directly; without a raw-HTML plugin (there is
//    none here, deliberately) an HTML tag in a body is text, not markup.
//    So `<script>` renders as the visible characters `<script>` and there
//    is no element, and no attribute, for an injection to land in. This is
//    safety by construction rather than by filtering — nothing is being
//    stripped, because nothing dangerous is ever built.
// 2. **Every URL goes through `safeUrl`.** Markdown's own link syntax is
//    the one channel that legitimately puts an author's string into an
//    `href`, and `javascript:` there executes. That policy lives in
//    `@/lib/item-detail/markdown` as a plain function so it is tested as a
//    rule; see its header for why an allowlist and why parsing.
//
// ── Why it is hook-free ────────────────────────────────────────────────
//
// Like every `*View`/presentational component here: the harness runs
// `environment: "node"` with no DOM, so a component with no hooks can be
// called as a function and the tree it returns walked
// (`tests/helpers/react-element.ts`). This one holds no state and takes
// one string, so there is nothing pulling against that.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeUrl } from "@/lib/item-detail/markdown";
import styles from "./Markdown.module.css";

export interface MarkdownProps {
  /** The markdown source. Empty or whitespace-only renders nothing at all. */
  readonly source: string;
  /**
   * How much room the block takes.
   *
   * `compact` is for a body nested inside a row — an artifact's, a history
   * entry's — where the surrounding text is already small and a full-size
   * `h2` would out-shout the row it sits in.
   *
   * `inline` is for a body that is one line and sits inside a line of
   * someone else's layout — a summary bullet in an `<li>`. It strips the
   * block margins so the rendered paragraph does not open a gap in the
   * middle of a list, and is not a licence to nest a table in a sentence:
   * a multi-block source will still render as blocks, it will just have no
   * outer spacing.
   */
  readonly density?: "normal" | "compact" | "inline";
  /** Applied alongside the block's own class, for a caller that needs to place it. */
  readonly className?: string;
}

/**
 * `remark-gfm` is constructed once at module scope rather than per render.
 *
 * The plugin list is a prop `react-markdown` compares by identity to decide
 * whether to rebuild its processor; a fresh array literal in the component
 * body is a new identity every render, which throws the processor away and
 * rebuilds it each time. A body of several hundred lines makes that
 * measurable, and it is avoided by simply not writing the literal inline.
 */
const REMARK_PLUGINS = [remarkGfm];

/** Density → the modifier class that expresses it. Module scope: it is a constant, not per-render state. */
const DENSITY_CLASS: Record<NonNullable<MarkdownProps["density"]>, string | null> = {
  normal: null,
  compact: styles.compact ?? null,
  inline: styles.inline ?? null,
};

export function Markdown({ source, density = "normal", className }: MarkdownProps) {
  // Nothing at all for an empty body, rather than an empty styled block.
  // A `<div>` with margins and no content is a gap the reader has to decide
  // the meaning of; no element is unambiguous.
  if (source.trim() === "") return null;

  const classes = [styles.markdown, DENSITY_CLASS[density], className]
    .filter((c) => c !== null && c !== undefined && c !== "")
    .join(" ");

  return (
    <div className={classes} data-density={density}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrl}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
