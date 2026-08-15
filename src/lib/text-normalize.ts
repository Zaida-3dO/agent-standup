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
