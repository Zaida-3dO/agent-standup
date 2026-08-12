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
   * The comparable part of a refusal — what conformance asserts is
   * identical across adapters. Message text is excluded by construction
   * rather than by asking every driver to remember to drop it.
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
  constructor(cause: unknown, message = "The operation failed unexpectedly.") {
    super("internal", message, { cause });
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
