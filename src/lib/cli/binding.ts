// The one interface both bindings sit behind (SCHEMA.md §20, DECISIONS §13f).
//
// This is the seam row #79 exists to establish. A `Binding` is a single
// method — call a named service operation with an input, get back either the
// result or the *rejection the service made*. Everything above it (the
// dispatcher, every `<noun> <verb>` command, the renderer, the exit code) is
// written once against this type and cannot tell which binding it is holding.
//
// **Why one method and not one method per command.** A binding with a
// `createItem`, a `getItem` and a `listItems` would have to grow a method for
// every operation, and the two implementations could then drift one operation
// at a time — which is precisely the failure DECISIONS §13f names ("the day a
// rule is implemented in a route handler instead of the service layer, the
// command line silently stops enforcing it"). With one method keyed on the
// operation registry, a command is a *name and an input*, so `direct` and
// `http` expose exactly the same set of operations by construction: neither
// has a surface of its own to add to.
//
// **Why it returns a rejection rather than throwing.** A thrown
// `ServiceError` from `direct` and a 422 body from `http` are different
// values in different shapes, so a caller comparing them would be comparing
// the two bindings' error handling rather than the two bindings' behaviour.
// Normalising both into `Rejection` — the service's own "comparable part of a
// refusal" — at the binding boundary is what lets one command implementation
// and one conformance assertion sit above them.
import type { Rejection } from "@/lib/service";

/** An accepted call. */
export interface BindingOk<T = unknown> {
  readonly ok: true;
  readonly data: T;
}

/**
 * A refused call.
 *
 * `rejection` is the comparable part — code, offending fields, and the rule
 * identifier for a guard. `message` is deliberately outside it: SCHEMA.md §22
 * compares codes and fields across adapters and explicitly does not compare
 * message text, "because a terminal and an API should word things
 * differently". Keeping the wording in a sibling field rather than inside
 * `rejection` means a comparison written against `rejection` cannot
 * accidentally include it.
 */
export interface BindingRejected {
  readonly ok: false;
  readonly rejection: Rejection;
  readonly message: string;
}

export type BindingResult<T = unknown> = BindingOk<T> | BindingRejected;

/**
 * How a command reaches the rules.
 *
 * Two implementations: `direct` runs the service layer in this process
 * against `DATABASE_URL`; `http` calls the API at `STANDUP_URL`. `name`
 * exists so `standup doctor` and the `--json` envelope can say which one ran
 * without any command having to ask — a command that branched on the binding
 * name would be exactly the caller-knows-its-own-transport coupling
 * DECISIONS §13f rules out.
 */
export interface Binding {
  readonly name: BindingName;
  /**
   * Calls one registered service operation.
   *
   * Rejects the returned promise only for a failure that is not a service
   * refusal at all — an unreachable server, a malformed response body.
   * Everything the *rules* decided comes back as a resolved
   * `BindingRejected`, because a rule refusing is an answer, not an error.
   */
  invoke(operation: string, input: unknown): Promise<BindingResult>;
}

/** The two bindings, by name. */
export const BINDING_NAMES = ["direct", "http"] as const;

export type BindingName = (typeof BINDING_NAMES)[number];

/** Whether a string names a binding. */
export function isBindingName(value: string): value is BindingName {
  return (BINDING_NAMES as readonly string[]).includes(value);
}

/** Wraps an accepted call, so neither implementation builds the shape by hand. */
export function bindingOk<T>(data: T): BindingOk<T> {
  return { ok: true, data };
}

/** Wraps a refusal. */
export function bindingRejected(rejection: Rejection, message: string): BindingRejected {
  return { ok: false, rejection, message };
}
