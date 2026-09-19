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
import { getOperation } from "@/lib/service/registry";
import { describeFields, type FieldDescriptor } from "@/lib/service/describe/fields";

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

/**
 * Field names a GET route reads by some route-specific rule of its own —
 * a path param folded into the input (`id`, `itemId`, `sessionId`), or a
 * shape whose URL spelling deliberately differs from the operation's own
 * (`get_board`'s `level`, spelled `level=exclude:0` on the wire — see that
 * route's header for why the two forms are not the same and must not be).
 *
 * Passed in per call rather than inferred, because "this field is handled
 * elsewhere" is a fact about the route, not about the schema — nothing in
 * `describeFields`'s answer says a field is spoken for.
 */
export type QueryInputExemptions = readonly string[];

/**
 * Reads every declared field of one operation's input off its own query
 * string, by name, coerced from the Zod node `describeFields` already
 * exposes — so a GET route stops being the one place a field has to be
 * remembered by hand.
 *
 * **Why this exists.** Every POST/PATCH/DELETE body path spreads or
 * delegates the whole body (`_shared/reference-row.ts`'s `Object.assign`),
 * so it structurally cannot drop a declared field. A GET's parameters live
 * in the query string instead of a body, so nothing spreads them — a
 * hand-written `searchParams.get` per field is the only way a GET route
 * reads its input, and two real fields (`get_projects`'s `limit`/`cursor`,
 * `get_board`'s `trust`) were declared and never read as a result. This
 * closes that class the same way the body routes are already closed:
 * **reading the schema instead of a hand-written list.**
 *
 * **Coercion, by the type `describeFields` reports:**
 *   - `boolean` — `parseBooleanParam`, so `?flag` alone still means true.
 *   - `number` — `Number(raw)` when finite, else the raw string is passed
 *     through untouched so the operation's own schema refuses it and names
 *     the field — the same rule every hand-written numeric reader here
 *     already followed, not a new one.
 *   - `array<…>` — every repetition via `searchParams.getAll`, because a
 *     query string has no other way to carry more than one value under one
 *     name (`get-activity.ts`'s filters are the existing case).
 *   - anything else (`string`, `enum`, `literal`) — the raw string,
 *     unexamined; the schema is the single place its vocabulary is judged.
 *
 * **What this deliberately does not attempt.** An `object`-typed field
 * (`get_board`'s `level`) has no generic query-string spelling — the route
 * that owns one already has its own codec and reads it separately, listed
 * in `exempt` so this helper does not also try and disagree with it. A
 * field absent from the query string is simply not written to the input,
 * the same "omit, don't default" rule every hand-written reader here
 * already followed, so the operation's own default still applies.
 */
export function queryInput(
  request: Request,
  operationName: string,
  exempt: QueryInputExemptions = [],
): Record<string, unknown> {
  const operation = getOperation(operationName);
  const input: Record<string, unknown> = {};
  if (!operation) return input;

  const url = new URL(request.url);
  const exemptions = new Set(exempt);
  const fields: readonly FieldDescriptor[] = describeFields(operation.input);

  for (const field of fields) {
    if (exemptions.has(field.name)) continue;

    if (field.type.startsWith("array<")) {
      const values = url.searchParams.getAll(field.name);
      if (values.length > 0) input[field.name] = values;
      continue;
    }

    const raw = url.searchParams.get(field.name);
    if (raw === null) continue;

    if (field.type === "boolean") {
      input[field.name] = parseBooleanParam(raw);
      continue;
    }

    if (field.type === "number") {
      const parsed = Number(raw);
      input[field.name] = raw.trim() !== "" && Number.isFinite(parsed) ? parsed : raw;
      continue;
    }

    input[field.name] = raw;
  }

  return input;
}
