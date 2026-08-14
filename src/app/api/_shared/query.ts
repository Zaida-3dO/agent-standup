// Query-string readers shared by the HTTP adapter's collection endpoints.
//
// A query string carries strings and nothing else, so a boolean filter has
// to be reconstituted somewhere. This is adapter work by SCHEMA.md §22's
// division — "the service never knows an HTTP status exists", and by the
// same token it never knows a query string exists either. It is a shape
// question ("is this string the word true?"), not a validation one; the
// operation's own schema is still the single place the *value* is checked,
// which is why an unrecognised string is passed through untouched rather
// than defaulted here.

/**
 * Reads a boolean filter out of a query parameter.
 *
 * **Present-but-empty means true** — `?includeTerminal` is how a query
 * string spells a bare flag, and a caller who typed it plainly meant to
 * turn it on; reading that as `false` would silently do the opposite of
 * what was asked. `true` and `1` are accepted for the callers that spell it
 * out.
 *
 * **Anything else is returned unchanged, as a string.** That is deliberate:
 * `?includeTerminal=yes` is not a boolean this adapter should quietly
 * decide the meaning of, and passing the raw string on lets the operation's
 * schema refuse it with `invalid_input` naming the field — the same
 * rejection every other adapter would produce for the same input. Mapping
 * it to `false` here would invent an adapter-specific answer to a question
 * the schema is the one place to answer.
 */
export function parseBooleanParam(raw: string): boolean | string {
  if (raw === "" || raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return raw;
}
