// Input-boundary text normalisation — MILESTONES.md #113's third part.
//
// This is a deliberate *normalisation choice*, unrelated to the encoding
// fault the rest of #113 investigates. An em dash that arrives correctly
// decoded (a real "—", U+2014, not a replacement character) is not corrupt —
// it is exactly the character the caller sent. Rewriting it to a plain
// hyphen here is a house-style decision — a task tracker stores `-` rather
// than a typographic dash — applied once, at the point every write enters
// the service layer, so every caller (MCP, the HTTP API, the command line)
// gets the same answer without each one having to know the rule.
//
// Scoped to the em dash specifically (U+2014), not "any dash-like
// character". An en dash (–, U+2013) commonly means something else in a
// title — a range, e.g. "2024–2026" — and folding it into a hyphen would be
// a lossier, uninvited change this row never asked for. Widen the set only
// on a specific, named request.
const EM_DASH = "—";

/**
 * Rewrites every em dash to a plain ASCII hyphen-minus.
 *
 * Pure and total — no locale, no async, safe to call from a Zod
 * `.transform()` on any string field that should carry this house style.
 */
export function normalizeEmDash(value: string): string {
  return value.split(EM_DASH).join("-");
}

/**
 * `normalizeEmDash`, plus whether it actually changed anything.
 *
 * The rewrite itself is silent by design (see this module's header) and
 * that silence is the correct call for `body` or any field nobody re-reads
 * to confirm a match — but a `title` is frequently used as a join key by an
 * importer with no id column, and a caller that never learns its title was
 * rewritten cannot know an exact-title lookup will miss the row it just
 * created. Callers that want to say so (MILESTONES.md #131's `titleAdvice`
 * mechanism) need the comparison made where both the original and the
 * rewritten string are still in hand — which is here, not after a Zod
 * `.transform()` has already thrown the original away.
 */
export function normalizeEmDashNoting(value: string): { value: string; rewritten: boolean } {
  const normalized = normalizeEmDash(value);
  return { value: normalized, rewritten: normalized !== value };
}
