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
 *
 * `P2028` (transaction API error) and `P2034` (transaction write conflict /
 * deadlock, which Prisma documents as retry-able) join it on that same line
 * and for the same reason. **The line they are on is load-bearing.** Added
 * below the `P2` prefix test instead, they would be unreachable — a
 * transaction that timed out would classify as `constraint_violation`,
 * which is worse than the `unexpected` default, because it names a specific
 * wrong cause: it asserts the caller's input collided with a stored row
 * when in fact the store was too busy to finish. A transaction failure is a
 * timing fact about the installation, not a fact about the payload.
 */
export function classifyCause(cause: unknown): InternalKind {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (
      code === "P1002" ||
      code === "P1008" ||
      code === "P2024" ||
      code === "P2028" ||
      code === "P2034"
    )
      return "timeout";
    if (code === "ETIMEDOUT") return "timeout";
    if (code.startsWith("P1")) return "database_unavailable";
    if (code.startsWith("P2")) return "constraint_violation";
  }
  if (cause instanceof Error && cause.name === "TimeoutError") return "timeout";
  return "unexpected";
}

// ── What a caller may do about it ────────────────────────────────────────
//
// `fault` says whose problem it is and `internalKind` says how the server
// broke; neither tells a caller the one thing it has to decide, which is
// **whether sending the same call again could work**. Four independent
// reports of a write failing with a bare `internal` and succeeding on an
// identical retry are what this exists to answer: every one of those
// callers guessed, and a caller guessing wrong in the unsafe direction
// either loses a write or makes two.
//
// **Derived from `code` + `internalKind`, never declared at a throw site**,
// for the reason `FAULT_BY_CODE` gives verbatim: there is one rule and ~200
// throw sites, so asking each to restate it is asking for the one that gets
// it wrong.

/**
 * Whether repeating the identical call could plausibly succeed.
 *
 * A `Record` keyed on the closed union, so **adding a code without
 * classifying it is a type error** — the same property that makes
 * `FAULT_BY_CODE` safe to extend.
 *
 * Every caller fault is `false`: the call was refused on its content, and
 * nothing about sending the same bytes again changes that. `not_implemented`
 * is `false` for the reason it is a *server* fault — no input would have
 * worked, and this build will not grow the operation between two attempts.
 * Only `internal` is conditional, and `internalKind` decides it.
 */
const RETRYABLE_BY_CODE: Record<ServiceErrorCode, boolean | "by_kind"> = {
  invalid_input: false,
  not_found: false,
  guard_rejected: false,
  conflict: false,
  forbidden: false,
  not_implemented: false,
  internal: "by_kind",
};

/**
 * Whether an `internal` of each kind is worth repeating.
 *
 * `constraint_violation` is **`false`**: the store refused the write on its
 * content, so it will refuse it again. That is the one bucket where an
 * `internal` is really a caller fault wearing a 500, and telling a caller to
 * retry it would be telling it to spin.
 *
 * `unexpected` — a bug, the honest default — is **`true`**, and the
 * reasoning is worth stating because the obvious one is wrong. It is *not*
 * that these writes are idempotent: `note`, `checkpoint` and
 * `record_artifact` are append-only with no idempotency key, no dedupe and
 * no uniqueness constraint, so a retry **duplicates** rather than being
 * absorbed. The argument is asymmetric cost. A duplicated note is visibly
 * redundant, human-readable and trivially ignored; a *lost* checkpoint is
 * silent, and silence is the failure this whole item exists to stop — a
 * checkpoint reporting three crews unblocked failed, and had the caller not
 * checked, an orchestrator would have gone on believing them blocked.
 *
 * This default is safe to state only because `committed` outranks it
 * (`retryabilityOf`): the case where a retry would actually double-write is
 * the case where the write already landed, and that is reported as
 * `retryable: false` regardless of what this table says.
 */
const RETRYABLE_BY_INTERNAL_KIND: Record<InternalKind, boolean> = {
  database_unavailable: true,
  timeout: true,
  constraint_violation: false,
  unexpected: true,
};

/**
 * Whether a failure is worth repeating, before `committed` is considered.
 *
 * A free function taking the pair rather than a method, because the CLI's
 * `http` binding rebuilds a rejection from a JSON body and never holds a
 * `ServiceError` — it has these two values and needs the same answer.
 */
export function retryableFor(code: ServiceErrorCode, internalKind?: InternalKind): boolean {
  const byCode = RETRYABLE_BY_CODE[code];
  if (byCode !== "by_kind") return byCode;
  return internalKind === undefined ? true : RETRYABLE_BY_INTERNAL_KIND[internalKind];
}

// ── What crosses to the caller, and what stays in the log ────────────────

/**
 * The internal kinds an adapter may render to a caller.
 *
 * **A deliberate subset, not the whole union.** `InternalError.internalKind`
 * is documented log-only, and the half of that argument which still holds is
 * about `constraint_violation`: it says the caller's input reached a write
 * and collided with a stored row, which is a fact about stored data rather
 * than about the request. It stays log-only and reports as `unexpected`.
 *
 * `timeout` and `database_unavailable` are the two that changed, because the
 * rest of that argument does not survive contact with MCP. It justified
 * withholding the bucket on the grounds that the caller "already has the
 * code, and the request id echoed as `X-Request-Id`" — true over HTTP, and
 * simply false over MCP, which has no headers and, until this change,
 * rendered nothing but `{"code":"internal"}`. All four reports arrived over
 * `mcp-http`. Both of these buckets say "the store was unreachable or too
 * slow", which discloses nothing about stored rows and is exactly what tells
 * a caller its retry is worth making.
 *
 * `unexpected` is withheld too, and not because it is sensitive — it is the
 * honest default and says nothing at all. It is withheld because it adds
 * nothing a caller can act on while *looking* like a diagnosis, and because
 * rendering it would put the key on every result and make its absence
 * meaningless. `tests/log-adapters.test.ts` asserts the key is absent here,
 * on exactly this bucket.
 */
const RENDERABLE_INTERNAL_KINDS: ReadonlySet<InternalKind> = new Set<InternalKind>([
  "timeout",
  "database_unavailable",
]);

/**
 * The internal kind to show a caller, or `undefined` to show none.
 *
 * Returns a member of the frozen `INTERNAL_KINDS` union or nothing at all —
 * **never a stringified cause, an interpolation, or anything read off
 * Prisma's `meta`**, which is what keeps `cause` from crossing the boundary
 * by a new route. Prisma puts constraint and column names in `meta.target`.
 *
 * A withheld bucket returns `undefined`, so the key is **omitted** rather
 * than reported as `"unexpected"`. Substituting a placeholder was the first
 * thing tried here and it is wrong twice over: it renders a kind on a
 * failure whose kind was deliberately not disclosed, and it destroys the
 * meaning of absence, which is what lets a reader tell "we are not saying"
 * from "we do not know".
 */
export function renderableInternalKind(internalKind?: InternalKind): InternalKind | undefined {
  if (internalKind === undefined) return undefined;
  return RENDERABLE_INTERNAL_KINDS.has(internalKind) ? internalKind : undefined;
}

// ── Whether the write landed ─────────────────────────────────────────────

/**
 * Whether the work a failed call was asking for actually happened.
 *
 * - **`false`** — it did not. The failure came from inside the transaction,
 *   so there is nothing to undo and nothing was recorded.
 * - **`true`** — it did, and the *response* is what failed. The caller was
 *   told the call failed; the write is in the database regardless.
 * - **`"unknown"`** — the transaction timed out or the connection dropped
 *   around the boundary, so neither this process nor the caller can tell.
 *   A bounded residue rather than a catch-all: it is reachable only from
 *   the `timeout` bucket, never from an ordinary failure.
 */
export type Committed = boolean | "unknown";

/**
 * The retryability a caller is actually told, after `committed` is applied.
 *
 * **`committed` outranks `retryable`, always.** `retryable: true` sitting
 * beside `committed: true` is not merely confusing, it is an instruction to
 * double-write — and on append-only operations with no dedupe, a caller that
 * follows it gets two rows. So a committed write is reported `false` no
 * matter what the code/kind table says.
 *
 * `"unknown"` is left retryable by the table, because the alternative is
 * worse: refusing to retry a write that may never have landed is how a
 * checkpoint goes missing silently. The message is what carries the caution,
 * directing a re-read first.
 */
export function retryabilityOf(
  code: ServiceErrorCode,
  internalKind: InternalKind | undefined,
  committed: Committed,
): boolean {
  if (committed === true) return false;
  return retryableFor(code, internalKind);
}

/**
 * What to tell a caller about a server fault, given what is known.
 *
 * One of a fixed set of strings. **Never caller-supplied, never
 * driver-supplied, never interpolated** — this is the same redaction
 * boundary `InternalError`'s fixed message already held, widened only to say
 * something useful rather than to say something new. Each string answers the
 * one question the caller is stuck on: do I send this again?
 */
export function internalMessageFor(committed: Committed, retryable: boolean): string {
  if (committed === true) {
    return "The write completed, but the response could not be rendered. Re-read before retrying: retrying would record it a second time.";
  }
  if (committed === "unknown") {
    return "The connection was lost while the write was in flight, so it may or may not have been recorded. Re-read before retrying.";
  }
  if (retryable) {
    return "The operation failed before anything was recorded, for a reason that may be temporary. It is safe to retry.";
  }
  return "The operation failed unexpectedly and nothing was recorded. Retrying is unlikely to help; quote the request id when reporting it.";
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
