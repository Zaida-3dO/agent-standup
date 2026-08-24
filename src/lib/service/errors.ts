// The service layer's error taxonomy. See docs/plans/SCHEMA.md §22.
//
// Every refusal a service operation makes is one of these, and every one
// carries a machine-readable `code` plus the `fields` it is about. That is
// not decoration: the adapter conformance suite compares *codes and
// offending fields* across adapters and deliberately does not compare
// message text, because a terminal and an API should word things
// differently. A refusal thrown as a bare `Error` has no code to compare,
// so it is invisible to that comparison — every adapter would report it
// differently and the suite would still pass.
//
// The taxonomy is closed on purpose. A caller can exhaustively switch on
// `ServiceErrorCode`, and adding a case to the union without handling it
// where it matters is a type error rather than a runtime surprise.

/**
 * The closed set of refusal kinds.
 *
 * Each maps to one transport-level outcome per adapter, and an adapter's
 * mapping is the *only* place transport concerns appear — the service never
 * knows an HTTP status exists.
 */
export const SERVICE_ERROR_CODES = [
  /** The input did not match the operation's schema. */
  "invalid_input",
  /** A named thing does not exist. */
  "not_found",
  /** A rule refused the operation. Carries `guard`. */
  "guard_rejected",
  /** Someone else holds what the caller asked for. */
  "conflict",
  /** The caller may not do this. */
  "forbidden",
  /** The operation is not implemented by this build. */
  "not_implemented",
  /** Something failed that the caller did nothing wrong to cause. */
  "internal",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

// ── The fault axis ───────────────────────────────────────────────────────
//
// A bare `internal` with no field beside it is the least actionable thing
// this layer can say. A refusal carries a `code`, and deciding whether a
// given code means "the caller did something wrong" or "the server broke"
// is knowledge that would otherwise live only in the head of whoever is
// reading the stream. That is the wrong place for it — the
// two want opposite responses (fix the call vs page someone), and a stream
// where both look alike is a stream where the second kind stops being seen.
//
// **Derived from `code`, never declared at a throw site.** There are ~200
// places that raise a refusal and exactly one rule for classifying them, so
// asking each throw to restate the rule is asking for the one that gets it
// wrong. A caller cannot pass a `fault`; there is no option for it.

/** Whose problem a refusal is. */
export const SERVICE_FAULTS = ["caller", "server"] as const;

export type ServiceFault = (typeof SERVICE_FAULTS)[number];

/**
 * Which fault each code carries.
 *
 * A `Record` keyed on the closed union rather than `code === "internal"`,
 * for the reason the union is closed at all: **adding a code without
 * classifying it is a type error.** The `code === "internal"` spelling has
 * the opposite property — a later `upstream_unavailable` would silently
 * classify as the caller's fault, which is exactly the direction that
 * hides a server failure.
 *
 * This is the concept `EXIT_BY_CODE` (`lib/cli/envelope.ts`) was already
 * approximating: its comment splits "the caller's command was wrong" from
 * "nothing the caller typed would have worked". That table stays as it is —
 * it makes a three-way split this two-way axis cannot express
 * (`invalid_input` earns a different exit code from `not_found`, though
 * both are the caller's fault) — and a test asserts the two never come to
 * disagree about which codes are unfixable by the caller.
 *
 * `not_implemented` is a **server** fault, agreeing with `EXIT_BY_CODE`
 * putting it on `EXIT.FAILURE`: no input the caller could have sent would
 * have worked, so there is nothing for them to fix, and an operator wants
 * to know a build is answering calls it cannot serve.
 */
const FAULT_BY_CODE: Record<ServiceErrorCode, ServiceFault> = {
  invalid_input: "caller",
  not_found: "caller",
  guard_rejected: "caller",
  conflict: "caller",
  forbidden: "caller",
  not_implemented: "server",
  internal: "server",
};

/**
 * The fault a code carries.
 *
 * A free function as well as a getter on the class because the CLI's `http`
 * binding reconstructs a `Rejection` from a JSON body and never holds a
 * `ServiceError` at all — it has a `code` and needs the same answer.
 */
export function faultFor(code: ServiceErrorCode): ServiceFault {
  return FAULT_BY_CODE[code];
}

// ── The sub-bucket, beneath `internal` ───────────────────────────────────
//
// `fault` splits the taxonomy in two; this splits the half that means
// trouble. "The server broke" is still not actionable on its own — an
// unreachable database, a rejected write and a genuine bug want three
// different responses, and nothing short of reading the `cause` by hand
// tells them apart.
//
// **Coarse, and derived from the driver's error code — never from message
// text and never from `meta`.** Prisma puts the constraint and column names
// in `meta.target`; a bucket derived from those would put schema details
// into a log line and, if it ever reached a client, into a response. The
// four values below are fixed strings, so no caller-supplied or
// schema-derived text can travel inside one.

/** How a server fault failed, coarsely. */
export const INTERNAL_KINDS = [
  /** The store could not be reached. */
  "database_unavailable",
  /** The store refused the write. */
  "constraint_violation",
  /** Something did not finish in time. */
  "timeout",
  /** A bug. The honest default. */
  "unexpected",
] as const;

export type InternalKind = (typeof INTERNAL_KINDS)[number];

/**
 * Buckets an underlying failure.
 *
 * Matching is on **code prefixes** rather than an exhaustive list, because
 * the list changes with the driver version and an unrecognised code
 * bucketing as `unexpected` is the safe direction — it says "a bug" about
 * something that may not be one, which costs a reader a glance at the
 * `cause` that is logged right beside it. The unsafe direction would be
 * claiming a specific cause the code does not support.
 *
 * `P1xxx` is Prisma's initialisation/connection family and `P2xxx` its
 * query family; `P2024` is pool-timeout and is bucketed as a timeout rather
 * than a constraint, which is why it is tested before the `P2` prefix.
 */
export function classifyCause(cause: unknown): InternalKind {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (code === "P1002" || code === "P1008" || code === "P2024") return "timeout";
    if (code === "ETIMEDOUT") return "timeout";
    if (code.startsWith("P1")) return "database_unavailable";
    if (code.startsWith("P2")) return "constraint_violation";
  }
  if (cause instanceof Error && cause.name === "TimeoutError") return "timeout";
  return "unexpected";
}

export interface ServiceErrorOptions {
  /**
   * The fields the refusal is about, so an adapter can point at them
   * without parsing the message.
   */
  fields?: readonly string[];
  /**
   * The rule identifier, for `guard_rejected`. §22's third assertion is
   * computed from *this* value as the service returned it, never from what
   * a test case declared, so a guard that has never actually fired is
   * detectable.
   */
  guard?: string;
  /** Structured extras an adapter may render. Never contains credentials. */
  details?: Readonly<Record<string, unknown>>;
  /** The underlying failure, kept for logs; never sent to a caller. */
  cause?: unknown;
}

/**
 * The base class every service refusal extends.
 *
 * A class rather than a plain object because it is thrown: an operation
 * body abandons the transaction by throwing, and the transaction boundary
 * needs to tell "this operation refused" apart from "the database fell
 * over" without inspecting duck-typed shapes across a module boundary.
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly fields: readonly string[];
  readonly guard?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ServiceErrorCode, message: string, options: ServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.fields = Object.freeze([...(options.fields ?? [])]);
    if (options.guard !== undefined) this.guard = options.guard;
    if (options.details !== undefined) this.details = options.details;
  }

  /**
   * Whose problem this is, derived from `code`.
   *
   * A getter rather than a stored field: it is a projection of `code`, and
   * a stored copy is a second value that can be set to something `code`
   * disagrees with. Deliberately **not** part of `toRejection()` — see the
   * note there.
   */
  get fault(): ServiceFault {
    return faultFor(this.code);
  }

  /**
   * The comparable part of a refusal — what conformance asserts is
   * identical across adapters. Message text is excluded by construction
   * rather than by asking every driver to remember to drop it.
   *
   * **`fault` is not here, on purpose.** It is a pure function of `code`,
   * which is already in this object, so transmitting it would put a
   * derivable value on the wire — and this shape is genuinely a wire
   * format: the CLI's `http` binding rebuilds a `Rejection` from a JSON
   * body, and the conformance drivers rebuild one from MCP structured
   * content. A key added here has to be added at every one of those points
   * or two adapters silently disagree about a refusal that is identical.
   * Any reader wanting the fault calls `faultFor(code)`.
   */
  toRejection(): Rejection {
    return {
      code: this.code,
      fields: this.fields,
      ...(this.guard === undefined ? {} : { guard: this.guard }),
    };
  }
}

/** A refusal reduced to exactly what is compared across adapters. */
export interface Rejection {
  readonly code: ServiceErrorCode;
  readonly fields: readonly string[];
  readonly guard?: string;
}

export class InvalidInputError extends ServiceError {
  constructor(message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("invalid_input", message, options);
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("not_found", message, options);
  }
}

/**
 * A rule refused. `guard` is required, not optional: a guard rejection
 * without a rule identifier is exactly the row that would leave §22's
 * coverage assertion silently unsatisfiable, so the type system asks for it
 * at the throw site where the answer is known.
 */
export class GuardRejectedError extends ServiceError {
  declare readonly guard: string;

  constructor(guard: string, message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("guard_rejected", message, { ...options, guard });
  }
}

export class ConflictError extends ServiceError {
  constructor(message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("conflict", message, options);
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("forbidden", message, options);
  }
}

export class NotImplementedError extends ServiceError {
  constructor(message: string, options: Omit<ServiceErrorOptions, "guard"> = {}) {
    super("not_implemented", message, options);
  }
}

/**
 * A failure the caller did nothing to cause.
 *
 * The message is fixed rather than taken from the underlying error: an
 * unexpected failure's text is written for whoever is reading the logs and
 * routinely contains a query, a connection string or a stack path. The
 * original is kept as `cause` for exactly that reader and never crosses an
 * adapter boundary.
 */
export class InternalError extends ServiceError {
  /**
   * How it failed, coarsely — for the log line, never for the caller.
   *
   * Computed once here rather than at each of the handful of throw sites,
   * so a failure wrapped by `toServiceError` (the overwhelming majority:
   * anything a driver or a bug throws) is bucketed on the same rule as one
   * raised deliberately.
   *
   * **Log-only.** It is not in `toRejection()` and no adapter renders it.
   * The bucket itself carries no schema text, but it is still a fact about
   * the *installation* rather than about the request — `constraint_violation`
   * on a 500 tells a caller their input reached a write and collided with a
   * stored row — and the actor who can act on a server fault is the
   * operator, not the caller, whose response is "retry or escalate" for all
   * four buckets alike. The caller already has the pair that makes a report
   * actionable: the code, and the request id echoed as `X-Request-Id`.
   */
  readonly internalKind: InternalKind;

  constructor(cause: unknown, message = "The operation failed unexpectedly.") {
    super("internal", message, { cause });
    this.internalKind = classifyCause(cause);
  }
}

/** Whether a thrown value is one of ours. */
export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError;
}

/**
 * Every thrown value as a `ServiceError`.
 *
 * Anything that is not already one becomes an `InternalError`, which is
 * what keeps the promise that a caller can switch exhaustively on `code`:
 * without this, a driver error or a `TypeError` would escape the taxonomy
 * and every adapter would have to invent its own handling for it.
 */
export function toServiceError(value: unknown): ServiceError {
  return isServiceError(value) ? value : new InternalError(value);
}
