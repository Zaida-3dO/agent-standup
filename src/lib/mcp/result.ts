// Rendering a service answer as an MCP tool result. See docs/plans/SCHEMA.md §22.
//
// This is MCP's equivalent of the web API's `respond.ts`: the one place a
// transport decides how a service outcome looks on the wire. The web API
// maps a rejection code onto an HTTP status; MCP has no statuses, so it maps
// the same code onto `isError` plus a structured payload. Neither mapping
// belongs in the service layer — §22: "the service never knows an HTTP
// status exists", and by the same reasoning it does not know what
// `isError` is either.
//
// The structured payload is what makes MCP's half of §22's first assertion
// checkable at all. A rejection rendered only as prose would leave a
// conformance driver parsing English to recover the code, so the rejection
// is emitted as JSON — the same `code` and `fields` the service produced,
// unedited — alongside the human-readable message an agent actually reads.
import { toServiceError } from "@/lib/service";
import type { Rejection } from "@/lib/service";

/**
 * A tool result, in the shape MCP defines.
 *
 * Declared here rather than imported from the SDK because it is the return
 * type of a transport-agnostic function: this is the protocol's data shape,
 * not any transport's, and stating it structurally keeps this module — and
 * everything that calls it — free of a dependency on how the bytes travel.
 */
export interface ToolResult {
  /**
   * Mutable rather than `readonly` on purpose: the SDK's `CallToolResult`
   * declares a mutable array, and a `readonly` one is not assignable to it.
   * Declaring this type structurally — instead of importing the SDK's — is
   * what keeps `./server.ts` free of a transport dependency, so it has to
   * match the shape the SDK will accept.
   */
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /**
   * MCP results carry arbitrary extra fields (`_meta` and anything a future
   * revision adds), so the protocol's own type has an index signature. This
   * one needs it to be assignable to that type; it is not an invitation to
   * put anything here.
   */
  [key: string]: unknown;
}

/** How a rejection appears to a caller: the comparable part, plus the prose. */
export interface RenderedRejection extends Rejection {
  readonly message: string;
}

/**
 * Recursively converts every `bigint` in `value` to its decimal string.
 *
 * `checkpoint` and `note` (`src/lib/service/operations/checkpoint.ts`,
 * `.../note.ts`) return `AppendedEvent` (`src/lib/events.ts`) unmapped —
 * `id`/`txId` arrive as real `bigint`, chosen there because Postgres's
 * `bigserial`/`xid8` values do not fit `number` without precision loss at
 * realistic table sizes. `JSON.stringify` throws on a raw `bigint` outright
 * rather than truncating it, so without this step both `toolSuccess`'s own
 * `text` field *and* the SDK's later serialisation of `structuredContent`
 * would fail — turning a checkpoint or note that was **already committed**
 * into a call the caller is told failed. HTTP's adapter carries the same fix
 * for the same two operations, once, at the route
 * (`serializeAppendedEvent`, `src/app/api/_shared/respond.ts`); MCP has one
 * rendering function for every operation rather than one route per
 * operation, so the fix belongs here instead, generically, rather than as a
 * per-tool special case this core has no mechanism to express (`tools.ts`:
 * "derived, not listed" — and `tests/mcp-adapter-mount.test.ts` asserts no
 * operation name is ever hand-written into this directory).
 *
 * Stringified, not left numeric, for the same reason `serializeAppendedEvent`
 * gives: a bigint serialised as a JSON number round-trips through a client's
 * `JSON.parse` as an imprecise `number`, the exact loss the `bigint` type
 * exists to avoid.
 *
 * A `Date` is passed through untouched rather than walked as a plain object
 * — `Object.entries` on a `Date` finds no own enumerable properties, so
 * walking one would silently replace it with `{}` and JSON.stringify's own
 * `Date.prototype.toJSON` (already relied on everywhere else here) would
 * never run.
 */
function bigintSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, bigintSafe(entry)]),
    );
  }
  return value;
}

/**
 * A successful call.
 *
 * The value is rendered as JSON text *and* as `structuredContent`, because
 * clients are split on which they read: `content` is the field every client
 * understands, and `structuredContent` is the one that arrives as data
 * rather than as text to be re-parsed. Sending both costs a serialisation
 * and removes a class of "the tool returned nothing" report.
 *
 * **The text is serialised compactly, and that is the whole of the saving.**
 * Both fields stay — dropping either is the change this deliberately does
 * not make, and the reasoning is worth stating because the obvious "stop
 * sending it twice" reading of the duplication is the wrong fix here. No
 * tool this adapter derives declares an `outputSchema` (`tools.ts` advertises
 * an input schema only), and the protocol's rule is that `content` MUST be
 * present when a tool defines no output schema, while `structuredContent` is
 * the optional half. So `text` is the field that cannot be dropped without
 * breaking every client, and `structuredContent` is the one whose absence a
 * strict client is entitled to complain about the moment an output schema is
 * ever added. Neither is safely removable; the indentation was never
 * load-bearing for either.
 *
 * Indentation is presentation, and there is no reader here to present to.
 * This JSON is parsed by a client or read by a model, and neither needs
 * two-space indentation to do it — a model is billed for the whitespace by
 * the token and a client discards it in `JSON.parse`. On a board-sized
 * answer the pretty rendering costs ~43% of the text field for nothing that
 * survives being read.
 *
 * A size-conditional rendering — compact only past some threshold — was the
 * other option and is deliberately rejected: it makes the wire format depend
 * on the payload, so a response changes shape as data grows, and a
 * fixture-based conformance suite cannot easily catch a format that only
 * misbehaves above a size no fixture reaches. One format at every size is
 * the cheaper property to keep.
 *
 * `undefined` — an operation that answers with nothing — is rendered as
 * `null` rather than as the empty string, because `JSON.stringify(undefined)`
 * is `undefined`, not text, and a content block whose text is missing is a
 * protocol error rather than an empty answer.
 */
export function toolSuccess(value: unknown): ToolResult {
  const safe = bigintSafe(value);
  const text = safe === undefined ? "null" : JSON.stringify(safe);
  const structuredContent = isPlainRecord(safe) ? safe : { result: safe ?? null };
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

/**
 * A refused call.
 *
 * `isError: true` rather than a thrown JSON-RPC error, deliberately: a
 * protocol-level error is for "this request was malformed", while a guard
 * refusing a transition is a perfectly well-formed request that the rules
 * declined — and an agent needs to *read* that refusal to decide what to do
 * next, which it can only do if the refusal arrives as a tool result.
 *
 * Anything thrown that is not already a service error becomes `internal`
 * via `toServiceError`, so this function has no path that leaks a stack
 * trace or a database message to a caller.
 *
 * Serialised compactly for the same reason `toolSuccess` is, and kept
 * identical to it on purpose rather than because a refusal is large: a
 * rejection is small enough that its own bytes hardly matter, but a
 * renderer with two JSON formats invites the question of which one a
 * given result used, and §22 compares rejections across adapters by
 * `code` and `fields` — neither of which whitespace changes. One format
 * for every result this module emits is the property worth holding.
 */
export function toolRejection(error: unknown): ToolResult {
  const serviceError = toServiceError(error);
  const rejection: RenderedRejection = {
    ...serviceError.toRejection(),
    message: serviceError.message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(rejection) }],
    structuredContent: { ...rejection, fields: [...rejection.fields] },
    isError: true,
  };
}

/** A non-null, non-array object — the only thing `structuredContent` may be. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
