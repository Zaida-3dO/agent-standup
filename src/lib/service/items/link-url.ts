// Validating a link's URL, and the one rule that decides what an item may
// point at.
//
// **A link's value is rendered as a clickable `href`, so this is a security
// boundary rather than a tidiness check.** Everything else on an item is
// displayed as text: a body containing `javascript:alert(1)` is a string a
// reader sees, and the worst it can do is look odd. A link is different in
// kind — the product's whole purpose for it is to put a URL somewhere a
// person clicks, which means an unsafe scheme stored here is an unsafe
// scheme *executed* on whoever opens the item. The validation therefore
// lives at the write path, where a bad value is refused once, rather than
// only at the renderer, where every future surface would have to remember
// to re-apply it.
//
// ── Why a denylist, when a denylist is usually the wrong instinct ───────
//
// The ordinary advice is to allow a known-good set and reject the rest, and
// for schemes that would mean `http` and `https`. That rule was written into
// an earlier draft of this work and is **measurably wrong for the corpus it
// has to serve**: a reporting installation stores 30 of its 35 document
// references as `coda://docs/<doc>/rows/<row>` resource URIs. Those are
// real, resolvable pointers that the installation's own tooling opens, and
// an http(s) allowlist rejects every one of them — so the feature would
// refuse the majority of the very links it exists to hold, and callers would
// go straight back to putting them in prose, which is the failure this
// feature exists to end.
//
// A scheme allowlist is also not a list that can be finished. `mailto:`,
// `slack:`, `vscode:`, `notion:`, `zoommtg:`, `obsidian:`, `cursor:` and an
// installation's own internal handler are all legitimate, and no list
// written here can anticipate the next one. Every addition would be a
// release of this product to serve a pointer that was already valid.
//
// The dangerous set, by contrast, **is** small, well-known and stable: the
// schemes that execute rather than locate. So the rule is inverted on
// purpose — name the handful that are unsafe, allow what remains — and the
// cost of being wrong is bounded in the right direction. A scheme wrongly
// allowed is a link that does not resolve; a scheme wrongly rejected is a
// caller who cannot record a real pointer at all.
//
// ── The comparison is made on a normalised scheme, which is the part that
//    actually does the work ──────────────────────────────────────────────
//
// A denylist is only as good as its inability to be spelled around, and a
// naive `startsWith("javascript:")` can be defeated several ways at once:
// `JavaScript:`, `java\tscript:`, ` javascript:`, and `java%73cript:` are
// all treated as `javascript:` by browsers that have to be bug-compatible
// with decades of the web. So the scheme is not string-matched off the raw
// input. It is extracted, stripped of the ASCII whitespace and control
// characters a URL parser ignores, and lowercased before it is compared —
// and the comparison is against a set, so no ordering or substring
// behaviour can be exploited. `tests/link-url.test.ts` pins each of those
// evasions individually, because each one is a separate way for this to
// silently stop working while still passing a test that only tries the
// obvious spelling.

/**
 * The schemes refused outright.
 *
 * Every member executes code or carries an inline payload rather than
 * naming a location, which is exactly the distinction that matters when the
 * value becomes an `href`:
 *
 * - `javascript:` runs script in the page's origin — the classic stored XSS
 *   vector, and the whole reason this module exists.
 * - `data:` carries its content inline, so `data:text/html,<script>…` is a
 *   document the browser renders with no server involved. It is a payload
 *   wearing a URL's clothes.
 * - `vbscript:` is `javascript:` for an older engine. Effectively dead in
 *   current browsers, and kept because a denylist that omits a known
 *   executable scheme on the grounds that it is unfashionable is a denylist
 *   with a hole in it, and the cost of the extra entry is one string.
 *
 * Exported so a test can assert the membership directly rather than
 * inferring it from refusals — a list is the kind of thing that gets
 * "tidied" by someone who does not know why `vbscript` is on it.
 */
export const REFUSED_URL_SCHEMES: readonly string[] = Object.freeze([
  "javascript",
  "data",
  "vbscript",
]);

/**
 * The longest URL a link may carry.
 *
 * Present because this column is indexed for search and rendered on a card,
 * not because any URL is meaningfully "too long" in the abstract. A bound
 * keeps one pathological value from dominating a trigram index and from
 * arriving as a megabyte in a board payload. Generous enough that no real
 * pointer approaches it — the longest shape in the motivating corpus is a
 * document URI well under 200 characters.
 */
export const LINK_URL_MAX_CHARS = 2048;

/**
 * The longest key a link may carry.
 *
 * A key is a chip label — `slack`, `ticket`, `design doc` — and the card
 * renders it verbatim, so the bound is what keeps a chip a chip. Short
 * enough to be a label rather than a sentence; long enough for the
 * multi-word labels the corpus actually uses.
 */
export const LINK_KEY_MAX_CHARS = 40;

/**
 * The characters a URL parser ignores inside a scheme, which therefore have
 * to be removed before the scheme is compared against the denylist.
 *
 * ASCII whitespace and every C0 control character. Browsers strip these when
 * resolving a URL — that behaviour is specified, not a quirk — so
 * `java\tscript:alert(1)` navigates exactly as `javascript:alert(1)` does. A
 * check that compared the raw text would see a scheme of `java\tscript`,
 * find it absent from the denylist, and store a live XSS vector while
 * reporting success.
 */
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f]/g;

/**
 * Pulls the scheme out of a URL and normalises it for comparison, or returns
 * null when the value names no scheme at all.
 *
 * "No scheme" covers a relative reference (`/items/x`, `./doc.md`) as well
 * as plain prose. Both are refused by the validator above rather than here:
 * this function answers only "what scheme is this", and a missing scheme is
 * a fact to report rather than an error to raise.
 *
 * Percent-decoding is applied to the scheme text before comparison, so
 * `java%73cript:` normalises to `javascript`. It is applied *only* to the
 * extracted scheme and never to the rest of the URL — decoding a whole URL
 * would change what it points at, and this function's job is to inspect the
 * value, never to rewrite it. The decode is guarded because a malformed
 * escape makes `decodeURIComponent` throw, and a throw here would turn a
 * junk URL into a crash rather than a refusal.
 *
 * Exported for its own test: the evasions this defends against are
 * properties of *this* function, and a test that could only reach it through
 * the validator would be asserting the denylist and the normaliser at once,
 * unable to say which of the two failed.
 */
export function schemeOf(url: string): string | null {
  // The scheme runs from the start to the first colon. Anything after that
  // colon is the scheme-specific part and is not this function's business —
  // note that a colon appearing later (a port, a time in a fragment) is
  // therefore irrelevant, because only the FIRST one delimits a scheme.
  const colonAt = url.indexOf(":");
  if (colonAt === -1) return null;

  const raw = url.slice(0, colonAt).replace(IGNORED_IN_SCHEME, "");
  if (raw === "") return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent escape. The undecoded text is still compared
    // below, which is the conservative reading: a scheme we could not fully
    // normalise is checked as it stands rather than waved through.
    decoded = raw;
  }
  // Re-strip after decoding, because a percent escape can itself encode one
  // of the ignored characters (`java%09script`).
  return decoded.replace(IGNORED_IN_SCHEME, "").toLowerCase();
}

/** Why a URL was refused — the message a caller is shown, or null when it is acceptable. */
export type LinkUrlRefusal = string | null;

/**
 * Decides whether a URL may be stored, returning the refusal reason or null.
 *
 * Returns a reason rather than throwing so the caller decides which error
 * type to raise and which field path to attach, and so a test can assert the
 * *decision* without catching. Every message names the offending value's
 * problem specifically, because "invalid URL" tells a caller holding a
 * `coda://` URI nothing about whether the rule or their value is wrong.
 */
export function refuseLinkUrl(url: string): LinkUrlRefusal {
  if (url.trim() === "") {
    return "A link's url must not be empty.";
  }
  if (url.length > LINK_URL_MAX_CHARS) {
    return `A link's url must be at most ${LINK_URL_MAX_CHARS} characters; this one is ${url.length}.`;
  }

  const scheme = schemeOf(url);
  if (scheme === null) {
    return (
      `A link's url must be absolute and carry a scheme — "${url}" names none. ` +
      `Any scheme is accepted (https://, coda://, slack://, mailto: and so on) ` +
      `except the executable ones: ${REFUSED_URL_SCHEMES.join(", ")}.`
    );
  }
  if (REFUSED_URL_SCHEMES.includes(scheme)) {
    return (
      `A link's url may not use the "${scheme}:" scheme, because a link is rendered as a ` +
      `clickable href and that scheme executes rather than locates. ` +
      `Every other scheme is accepted.`
    );
  }
  // A scheme and nothing else (`https:`) points at nothing. Cheap to catch
  // here and confusing to render: a chip that navigates nowhere looks like a
  // broken product rather than a link somebody recorded wrong.
  if (url.slice(url.indexOf(":") + 1).trim() === "") {
    return `A link's url must name something after its scheme — "${url}" is a scheme alone.`;
  }
  return null;
}
