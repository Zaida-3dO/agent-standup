// The URL policy the markdown renderer applies to every link and image.
//
// ── Why this is a module and not a library default ─────────────────────
//
// `react-markdown` renders markdown to React elements WITHOUT an HTML
// parser: raw `<script>`, `<img onerror=…>` and `<div onclick=…>` in a body
// arrive as literal text and are escaped, because there is no plugin
// turning HTML source into HTML nodes. That is the property doing most of
// the safety work here, and it is worth stating plainly: the renderer is
// safe by CONSTRUCTION — no HTML is parsed, so no attribute exists to be
// stripped.
//
// What that leaves is the one channel markdown's own syntax opens:
// `[text](url)` and `![alt](url)` put an author-controlled string into an
// `href`/`src`, and `javascript:` in that position executes on click. The
// renderer ships a default that handles it, and this module deliberately
// does not rely on that default for two reasons.
//
// **It must be testable as a rule, not as a rendering.** A test that
// asserts "the rendered anchor is harmless" proves the current version of
// a dependency behaves; a test over this function proves the *policy* —
// which schemes are permitted and which are refused — and it fails on the
// scheme that was added rather than only on the one that was sampled.
//
// **A default is not a commitment.** Bodies here are written by agents and
// stored, so this is a stored-content render path: the input is not
// trusted, and the thing standing between it and an `href` should be an
// explicit decision in this repository rather than an unstated behaviour a
// dependency upgrade is free to change.
//
// The list is an ALLOWLIST, which is the direction that fails safe. A
// denylist of `javascript:` and `data:` is a list of the attacks someone
// thought of, and every scheme nobody thought of passes; an allowlist
// refuses everything it was not taught, so a novel scheme is refused by
// default and the cost of being wrong is a link that does not work.

/**
 * The URL schemes a body may link to.
 *
 * `http`/`https` are the web. `mailto` is here because a brief legitimately
 * carries an address to write to. `data:` is deliberately absent even
 * though it has honest uses (an inline image): `data:text/html` is a
 * same-origin script execution vector, and distinguishing the safe media
 * types from the dangerous ones is a parsing problem — the payload is
 * author-controlled and the type label is author-supplied, so the label
 * cannot be the thing trusted to decide.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * What a refused URL becomes.
 *
 * Empty string, not the original and not a `#`. Returning the original
 * would defeat the whole function; returning `#` would leave a link that
 * looks live and silently jumps to the top of the page, which reads as a
 * broken feature rather than as a refusal. Empty renders as an anchor with
 * an empty `href` — visibly inert, and carrying nothing that executes.
 */
const REFUSED = "";

/**
 * A URL as it is safe to place in an `href` or `src`, or `""` if it is not.
 *
 * **Relative URLs are permitted.** A body may reasonably link to `/items/x`
 * or `./docs/PLAN.md`, and a relative reference carries no scheme, so there
 * is no scheme to abuse — the browser resolves it against this origin.
 * They are recognised by `URL` parsing failing without a base, which is
 * exactly what "has no scheme" means.
 *
 * **Parsing decides, never a string match.** `javascript:alert(1)` is the
 * obvious spelling, but `JavaScript:`, ` javascript:` with a leading
 * control character, and `java\tscript:` are all treated as the same scheme
 * by a browser and by `URL`, and defeat a `startsWith("javascript:")`
 * check. Handing the string to the same parser the browser uses removes
 * that entire class of near-miss.
 */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return REFUSED;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // No scheme — a relative reference. Refuse a protocol-relative URL
    // (`//host/path`) all the same: it parses as relative here but a
    // browser resolves it to an absolute request against another origin,
    // so allowing it would let a body reach off-origin through a form this
    // function had classified as same-origin.
    return trimmed.startsWith("//") ? REFUSED : trimmed;
  }

  return ALLOWED_SCHEMES.has(parsed.protocol) ? trimmed : REFUSED;
}
