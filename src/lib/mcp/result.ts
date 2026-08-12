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
 * A successful call.
 *
 * The value is rendered as JSON text *and* as `structuredContent`, because
 * clients are split on which they read: `content` is the field every client
 * understands, and `structuredContent` is the one that arrives as data
 * rather than as text to be re-parsed. Sending both costs a serialisation
 * and removes a class of "the tool returned nothing" report.
 *
 * `undefined` — an operation that answers with nothing — is rendered as
 * `null` rather than as the empty string, because `JSON.stringify(undefined)`
 * is `undefined`, not text, and a content block whose text is missing is a
 * protocol error rather than an empty answer.
 */
export function toolSuccess(value: unknown): ToolResult {
  const text = value === undefined ? "null" : JSON.stringify(value, null, 2);
  const structuredContent = isPlainRecord(value) ? value : { result: value ?? null };
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
 */
export function toolRejection(error: unknown): ToolResult {
  const serviceError = toServiceError(error);
  const rejection: RenderedRejection = {
    ...serviceError.toRejection(),
    message: serviceError.message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(rejection, null, 2) }],
    structuredContent: { ...rejection, fields: [...rejection.fields] },
    isError: true,
  };
}

/** A non-null, non-array object — the only thing `structuredContent` may be. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
