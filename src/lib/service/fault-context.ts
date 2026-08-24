// The log context a refusal contributes, in one place.
//
// Five call sites decide a log level by asking "is this the server's
// fault" — the service runtime, the HTTP responder(s), the MCP adapter and
// both CLI bindings. Each of them then wants the same two fields on the
// line it writes. Written out five times, that is five chances for one of
// them to omit `internalKind`, or to spell it differently, and the whole
// value of a structured field is that one query finds every line carrying
// it.
//
// So the fields are built here and spread there. This module deliberately
// does **not** write anything: the level, the message and the surrounding
// context differ per adapter, and centralising those too would produce one
// line that reads as though it came from nowhere.
import { faultFor, isServiceError, type ServiceErrorCode, type ServiceFault } from "./errors";
import type { InternalKind } from "./errors";

export interface FaultContext {
  readonly fault: ServiceFault;
  readonly internalKind?: InternalKind;
}

/**
 * The `fault` — and, when the value is an `InternalError`, the coarse
 * bucket beneath it — as log context.
 *
 * Takes the thrown value rather than a `ServiceError` so a caller need not
 * normalise first, and takes a `code` overload for the CLI's `http`
 * binding, which holds a `Rejection` rebuilt from JSON and never has the
 * original object at all.
 *
 * `internalKind` is omitted rather than written as `undefined` for every
 * non-internal refusal, matching `callerContext` in `runtime.ts`: a line
 * carrying empty fields is a line with more to read past and nothing more
 * to learn.
 */
export function faultContext(value: unknown): FaultContext;
export function faultContext(code: ServiceErrorCode): FaultContext;
export function faultContext(value: unknown): FaultContext {
  if (typeof value === "string") {
    return { fault: faultFor(value as ServiceErrorCode) };
  }
  if (isServiceError(value)) {
    // `internalKind` lives on `InternalError`, which is the only subclass
    // that has a cause worth bucketing. Read structurally rather than with
    // `instanceof` so a future server-fault subclass that computes one is
    // picked up without this module being edited to know about it.
    const kind = (value as { internalKind?: InternalKind }).internalKind;
    return {
      fault: value.fault,
      ...(kind === undefined ? {} : { internalKind: kind }),
    };
  }
  // Anything not already ours becomes an `internal` at the boundary
  // (`toServiceError`), so it is a server fault by the same rule rather
  // than by a second opinion stated here.
  return { fault: "server" };
}
