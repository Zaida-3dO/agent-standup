// The command line's one output shape and its exit codes (SCHEMA.md §20).
//
// Every command produces one of these, whichever binding ran it, and the
// renderer turns it into `--json` on standard output or human text on
// standard error. Two properties are load-bearing and neither is cosmetic:
//
//   - **The error code is the same identifier the API returns.** It is a
//     `ServiceErrorCode` by type, not a string the command line invented,
//     so "identical rejections across adapters" is a comparison the type
//     system already forces to be about the same values (SCHEMA.md §22).
//   - **Exit codes separate the situations that want opposite responses.**
//     A rule refusing (`3`) is a different event from a malformed command
//     (`2`) or an unexpected failure (`1`), and a script reacting to all
//     three the same way is exactly the confusion the split exists to
//     prevent.
import type { Rejection, ServiceErrorCode } from "@/lib/service";

/** The accepted answer: one document, one envelope. */
export interface OkEnvelope<T = unknown> {
  readonly ok: true;
  readonly data: T;
}

/** The refused answer. `code` and `fields` are the service's, verbatim. */
export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: ServiceErrorCode | "malformed_command";
    readonly message: string;
    readonly fields: readonly string[];
    /** The rule that refused, for `guard_rejected`. */
    readonly guard?: string;
  };
}

export type Envelope<T = unknown> = OkEnvelope<T> | ErrorEnvelope;

/**
 * The exit codes, by name.
 *
 * `MALFORMED` is the one that is not a service outcome: an unknown noun, a
 * missing verb or an unparseable flag never reaches the service layer at
 * all, so it has no `ServiceErrorCode` to map from. It gets its own code in
 * the error envelope for the same reason — a caller reading `--json` should
 * not have to tell "the service refused your input" apart from "this is not
 * a command" by parsing prose.
 */
export const EXIT = {
  /** Accepted. */
  OK: 0,
  /** Unexpected failure — the caller did nothing wrong to cause it. */
  FAILURE: 1,
  /** Malformed command — not a thing this build can be asked to do. */
  MALFORMED: 2,
  /** Rejected by a rule. */
  REJECTED: 3,
  /** Not configured — neither binding could be resolved. */
  UNCONFIGURED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Which exit code each refusal earns.
 *
 * `not_found`, `conflict` and `forbidden` are all `3`: every one of them is
 * the installation saying no on purpose, which is the distinction the exit
 * code carries. `invalid_input` is `2` — the caller's command was wrong,
 * which is the same class of mistake as a misspelled verb, and a script
 * retrying a rejection should not retry a typo. `internal` and
 * `not_implemented` are `1`: nothing the caller typed would have worked.
 */
const EXIT_BY_CODE: Record<ServiceErrorCode, ExitCode> = {
  invalid_input: EXIT.MALFORMED,
  not_found: EXIT.REJECTED,
  guard_rejected: EXIT.REJECTED,
  conflict: EXIT.REJECTED,
  forbidden: EXIT.REJECTED,
  not_implemented: EXIT.FAILURE,
  internal: EXIT.FAILURE,
};

/** The exit code an envelope leaves the process with. */
export function exitCodeFor(envelope: Envelope): ExitCode {
  if (envelope.ok) return EXIT.OK;
  if (envelope.error.code === "malformed_command") return EXIT.MALFORMED;
  return EXIT_BY_CODE[envelope.error.code];
}

/** Wraps an accepted result. */
export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

/**
 * Wraps a refusal the service made.
 *
 * Takes the `Rejection` the service produced rather than re-deriving one,
 * so the code, fields and rule identifier reaching a caller are the values
 * the service returned and not a copy an adapter maintained.
 */
export function rejected(rejection: Rejection, message: string): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: rejection.code,
      message,
      fields: rejection.fields,
      ...(rejection.guard === undefined ? {} : { guard: rejection.guard }),
    },
  };
}

/** Wraps a command this build cannot parse. Never reaches the service layer. */
export function malformed(message: string, fields: readonly string[] = []): ErrorEnvelope {
  return { ok: false, error: { code: "malformed_command", message, fields } };
}
