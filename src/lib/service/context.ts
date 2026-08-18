// What an operation body is handed. See docs/plans/SCHEMA.md §17.3, §22.
//
// An operation gets a context and its input, and nothing else. It cannot
// reach a client, open its own transaction, or read settings — all three
// arrive here, already resolved, already inside the boundary. That is the
// module boundary §22 turns into a lint rule: an operation that cannot
// import the database client cannot bypass the transaction, and an
// operation that cannot resolve settings cannot resolve a second snapshot.
import type { SettingsSnapshot } from "@/lib/settings";

/**
 * The database handle an operation runs against.
 *
 * Deliberately narrow, and deliberately *not* `PrismaClient`: the handle an
 * operation receives is a transaction handle, and Prisma's transaction
 * handle has no `$transaction` on it. Typing the parameter as the full
 * client would let an operation body call `$transaction` — the one call
 * that would open a second, nested boundary — and typecheck. It cannot
 * call what the type does not have.
 */
export interface TransactionHandle {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Who is calling. Enough to authorise and to attribute an event. */
export interface Caller {
  /** The session making the call, if there is one. */
  readonly sessionId?: string;
  /** The person or agent the session acts as, if known. */
  readonly actor?: string;
  /**
   * The machine a request authenticated as, when the transport proved one.
   *
   * The distinction from `actor` is the point of the field. An actor is
   * what a caller *says* it is — a header on an HTTP call, a value passed
   * on a direct one — and nothing anywhere verifies it. A machine here is
   * what a caller *proved*: a per-machine bearer token resolved to the
   * machine that holds it, on a transport that refuses the call outright
   * when it does not. Keeping them in separate fields is what stops a
   * verified fact and a self-report being read as the same kind of thing
   * by whatever comes to consume them.
   *
   * Optional because not every transport can prove one — a command line
   * running against the database directly is the same trust boundary as
   * the process itself, and has no token to present. Absent means "not
   * established", never "not trusted".
   */
  readonly machine?: string;
  /**
   * How the call arrived. The same names the conformance drivers use
   * (`SCHEMA.md` §21) — an adapter stamps it, an operation never guesses.
   */
  readonly transport?: string;
  /**
   * The id that ties every log line written for this call together.
   *
   * Minted at the boundary the call arrived through, so a single id spans
   * the adapter's own lines and the guard's — which is what makes two
   * concurrent failures tellable apart in one stream. Optional here and
   * defaulted by `ServiceRuntime.call`, so an adapter that has not been
   * taught to mint one still produces correlated lines rather than
   * unlabelled ones; an adapter that *has* keeps its own id, because the
   * adapter is where the call actually began and it has lines of its own to
   * stamp before the service is ever reached.
   *
   * It is deliberately not a secret and deliberately not derived from
   * anything: it identifies a call within a log stream and nothing else, so
   * an adapter may echo it back to a caller (`X-Request-Id`) without
   * disclosing anything.
   */
  readonly requestId?: string;
}

/**
 * Everything an operation body may use.
 *
 * `settings` is a value, not a getter and not a cache: an operation is
 * handed the one snapshot resolved for this call and has no way to ask for
 * another. Two guards inside one transaction therefore cannot disagree
 * about configuration, which is the failure §17.3 says would appear
 * roughly never and be impossible to reproduce.
 */
export interface ServiceContext {
  readonly db: TransactionHandle;
  readonly settings: SettingsSnapshot;
  readonly caller: Caller;
  /** The operation being run, for logging and event attribution. */
  readonly operation: string;
}
