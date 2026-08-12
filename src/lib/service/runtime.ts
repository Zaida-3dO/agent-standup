// The service runtime: one call, one snapshot, one transaction.
// See docs/plans/SCHEMA.md §17.3 and §22.
//
// This is the seam the whole application is built on. An adapter — HTTP,
// MCP over either transport, the command line on either binding — does
// three things: parse a request into a name and an input, call
// `callOperation`, render the result. It never opens a transaction, never
// resolves settings, and never touches the database client, so a rule
// cannot be implemented inside one adapter and missing from another.
import { toServiceError, InvalidInputError, NotFoundError } from "./errors";
import { getOperation } from "./registry";
import type { OperationName, OperationOutput } from "./registry";
import type { Caller, ServiceContext, TransactionHandle } from "./context";
import type { SettingsSnapshot } from "@/lib/settings";

/**
 * What the runtime needs from the world, so it is testable without a
 * database and composable with whatever client the process has.
 */
export interface ServiceRuntimeOptions {
  /**
   * Runs `body` inside one transaction and returns its result. Rejecting
   * must roll back — that is the contract this whole module rests on, and
   * `prismaTransactionRunner` below is the production implementation of it.
   */
  transaction: <T>(body: (db: TransactionHandle) => Promise<T>) => Promise<T>;
  /**
   * Resolves the settings snapshot. Called **exactly once per call**, by
   * `callOperation`, before the transaction opens.
   */
  resolveSnapshot: () => Promise<SettingsSnapshot>;
}

export interface CallOptions {
  readonly caller?: Caller;
}

/**
 * The one entry point into the service layer.
 *
 * The order of the four steps is the design, not an implementation detail:
 *
 *   1. **Look the operation up in the registry.** An unregistered name is
 *      refused here, so an adapter cannot smuggle a call past the index the
 *      conformance harness checks it against.
 *   2. **Parse the input against the operation's own schema.** Once, here,
 *      so every adapter rejects the same input with the same code and the
 *      same offending fields — which is what §22's first assertion
 *      compares.
 *   3. **Resolve exactly one settings snapshot**, *before* the transaction
 *      opens and once for the whole call. Every guard the operation runs
 *      sees that same frozen object, so two checks in one transaction
 *      cannot disagree about configuration (§17.3).
 *   4. **Run the body in one transaction.** The body throws to abandon it;
 *      there is no partial-commit path because there is no second
 *      boundary to commit at.
 *
 * Resolving *outside* the transaction is deliberate. Inside, the settings
 * read would join the transaction and hold its snapshot open for the
 * duration of the work — and on a revalidation miss it would issue database
 * reads from inside a transaction the caller opened for something else.
 * The cost is that a settings write committing between resolution and the
 * transaction is not seen by this call; the benefit is that the call is
 * internally consistent, which is the property §17.3 asks for. A call
 * racing a configuration change may use either side of it, but never both.
 */
export class ServiceRuntime {
  readonly #transaction: ServiceRuntimeOptions["transaction"];
  readonly #resolveSnapshot: ServiceRuntimeOptions["resolveSnapshot"];

  constructor({ transaction, resolveSnapshot }: ServiceRuntimeOptions) {
    this.#transaction = transaction;
    this.#resolveSnapshot = resolveSnapshot;
  }

  /**
   * Calls a registered operation by name.
   *
   * Every throw leaves as a `ServiceError`: an operation's own refusal
   * unchanged, anything else wrapped as `internal` with the original kept
   * as `cause`. A caller can therefore switch exhaustively on `code`
   * without a default arm that guesses.
   */
  async call<N extends OperationName>(
    name: N,
    input: unknown,
    options?: CallOptions,
  ): Promise<OperationOutput<N>>;
  async call(name: string, input: unknown, options?: CallOptions): Promise<unknown>;
  async call(name: string, input: unknown, options: CallOptions = {}): Promise<unknown> {
    const operation = getOperation(name);
    if (!operation) {
      throw new NotFoundError(`No such operation: ${name}.`, {
        fields: ["operation"],
        details: { operation: name },
      });
    }

    const parsed = operation.input.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      throw new InvalidInputError(
        `Invalid input for ${operation.name}: ${issues.map((issue) => issue.message).join("; ")}`,
        {
          // The paths the schema objected to, so an adapter can point at
          // the fields without re-parsing the message. Deduplicated
          // because one field can raise several issues, and a caller
          // reading "title, title, title" learns nothing extra.
          fields: [
            ...new Set(
              issues.map((issue) => issue.path.map((segment) => String(segment)).join(".")),
            ),
          ].filter((path) => path.length > 0),
        },
      );
    }

    // Step 3 — once, here, for the whole call. Not in the operation, not
    // per guard, and not inside the transaction.
    const settings = await this.#resolveSnapshot();

    try {
      return await this.#transaction(async (db) => {
        const ctx: ServiceContext = {
          db,
          settings,
          caller: options.caller ?? {},
          operation: operation.name,
        };
        return await operation.handler(ctx, parsed.data as never);
      });
    } catch (error) {
      throw toServiceError(error);
    }
  }
}

/** The narrow slice of a Prisma client the runtime uses. */
export interface TransactionCapableClient {
  $transaction<T>(
    body: (tx: TransactionHandle) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
}

/**
 * The production transaction runner.
 *
 * A thin wrapper, but a named one, because it is the single place the
 * boundary is actually opened — `ServiceRuntime` names the boundary in its
 * type and this is the only implementation that reaches a database. A test
 * substitutes its own; nothing else in the service layer knows Prisma
 * exists.
 */
export function prismaTransactionRunner(
  client: TransactionCapableClient,
  options?: { timeout?: number; maxWait?: number },
): ServiceRuntimeOptions["transaction"] {
  return <T>(body: (db: TransactionHandle) => Promise<T>) => client.$transaction(body, options);
}
