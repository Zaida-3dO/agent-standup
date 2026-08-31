// The service runtime: one call, one snapshot, one transaction.
// See docs/plans/SCHEMA.md §17.3 and §22.
//
// This is the seam the whole application is built on. An adapter — HTTP,
// MCP over either transport, the command line on either binding — does
// three things: parse a request into a name and an input, call
// `callOperation`, render the result. It never opens a transaction, never
// resolves settings, and never touches the database client, so a rule
// cannot be implemented inside one adapter and missing from another.
import type { z } from "zod";
import { toServiceError, InvalidInputError, NotFoundError } from "./errors";
import { faultContext } from "./fault-context";
// A read whose response will not fit refuses rather than overflowing the
// caller it was read in (MILESTONES.md #115).
import { enforceResponseSize } from "./response-size";
import { getOperation } from "./registry";
import type { OperationName, OperationOutput } from "./registry";
import type { Caller, ServiceContext, TransactionHandle } from "./context";
// A refusal names the call that would have prevented it, spelled for the
// surface the caller is on (MILESTONES.md #111).
import { invocationWithArgumentFor, surfaceForTransport } from "@/lib/surfaces";
import { log, newRequestId } from "@/lib/log";
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
  /**
   * Attaches whatever the interventions noticed to a finished result
   * (MILESTONES.md #128).
   *
   * **Optional, and absent means the feature is simply not present** - the
   * result is returned exactly as the operation produced it. That default
   * is what lets this be added to a seam every existing caller already uses
   * without changing what any of them see: a runtime constructed without a
   * deliverer behaves identically to one built before this parameter
   * existed.
   *
   * It is handed the result and the caller, and deliberately **no database
   * handle**. The transaction has closed by the time it runs, so there is
   * nothing for it to join even if it wanted one - which is the property
   * that keeps the ordinary path query-free, and the same contract the
   * predicates themselves are held to.
   *
   * Synchronous on purpose. An async deliverer would put an await on every
   * response in the system to compute an advisory field, and everything it
   * needs is already in memory by the time it is called.
   */
  deliverInterventions?: (result: unknown, caller: Caller) => unknown;
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
  readonly #deliverer: ServiceRuntimeOptions["deliverInterventions"];

  constructor({ transaction, resolveSnapshot, deliverInterventions }: ServiceRuntimeOptions) {
    this.#transaction = transaction;
    this.#resolveSnapshot = resolveSnapshot;
    this.#deliverer = deliverInterventions;
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
    // Minted here when the adapter did not supply one, so that no line
    // written for this call is unlabelled — an in-process caller (a script,
    // a test, the backfill runner) reaches the runtime without crossing an
    // adapter at all, and an unlabelled line is exactly the one an operator
    // cannot correlate. An adapter's own id wins, because the adapter is
    // where the call began and it has lines of its own already stamped
    // with it.
    const caller: Caller = {
      ...(options.caller ?? {}),
      requestId: options.caller?.requestId ?? newRequestId(),
    };
    const requestId = caller.requestId;

    // The line that makes the rest of a request's lines findable. `debug`,
    // because one per call is the highest-volume thing this application
    // logs and an operator wants it only when actually following a request
    // — the `info` default deliberately leaves it out.
    //
    // The input is **not** logged, at any level. It is caller-supplied and
    // unbounded, and `put_setting` carries a settings value whose key may
    // be marked `sensitive` (`settings/registry`) — a rule this module has
    // no way to consult and should not have to. Logging the operation, the
    // transport and who called is what an operator needs to follow a
    // request; logging what they sent is how a credential ends up in a log
    // aggregator.
    log.debug("Service call started.", {
      requestId,
      operation: name,
      ...callerContext(caller),
    });

    try {
      const result = await this.#dispatch(name, input, caller);
      log.debug("Service call finished.", { requestId, operation: name });
      return result;
    } catch (error) {
      const serviceError = toServiceError(error);
      // The one level split worth stating. An `internal` is a failure
      // nobody asked for, so it is logged with its `cause` — that is #97's
      // motivating failure and the whole reason `InternalError` keeps the
      // original. Every other code is a refusal the caller caused and the
      // response already explains, so it is `debug`: an operator following
      // a request wants to see it, and an operator watching for trouble
      // must not have the one code that means trouble buried under a
      // thousand well-earned 404s.
      //
      // The `cause` reaches the log and stops there. `serviceError` is
      // rendered by `describeError`, which walks the chain; what an adapter
      // renders is `toRejection()` plus the fixed message, which has never
      // included it. The redaction boundary is unchanged by this line.
      //
      // Wrapping **the whole dispatch**, rather than only the transaction,
      // is what makes that split hold for every exit path. An unregistered
      // operation and an input that fails its schema are refused before a
      // transaction is ever opened, and they are the two most ordinary
      // refusals there are — a catch around the transaction alone would
      // leave exactly those two invisible, which is the shape of the hole
      // this row exists to close.
      //
      // Split on `fault` rather than on `code === "internal"` so the rule
      // lives in one table (`FAULT_BY_CODE`) instead of being restated at
      // each site that asks the question. It puts `not_implemented` on
      // this branch, which is the point: a build answering a call it cannot
      // serve is not the caller's mistake, and it is the kind of fault an
      // operator has to see at the default threshold.
      if (serviceError.fault === "server") {
        log.error("Service call failed unexpectedly.", {
          requestId,
          operation: name,
          ...callerContext(caller),
          ...faultContext(serviceError),
          err: serviceError,
        });
      } else {
        log.debug("Service call refused.", {
          requestId,
          operation: name,
          code: serviceError.code,
          ...faultContext(serviceError),
          ...(serviceError.guard === undefined ? {} : { guard: serviceError.guard }),
        });
      }
      throw serviceError;
    }
  }

  /**
   * The four steps, with no logging in them.
   *
   * Split out so `call` above can wrap every exit path in one place: the
   * refusals raised before the transaction opens have to reach the same log
   * line as the ones raised inside it, and a second `catch` down here would
   * be a second place for that decision to drift.
   */
  async #dispatch(name: string, input: unknown, caller: Caller): Promise<unknown> {
    const operation = getOperation(name);
    if (!operation) {
      // Routed like a shape refusal, and for a stronger reason: a caller
      // holding a name that does not exist is the caller least able to
      // guess the one that does. `describe_tool` refuses an unknown tool
      // with the list of known ones, so following this pointer answers the
      // question rather than merely restating it.
      throw new NotFoundError(
        `No such operation: ${name}. Call ${invocationWithArgumentFor(
          "describe_tool",
          name,
          surfaceForTransport(caller.transport),
        )} to see the tools this build exposes.`,
        {
          fields: ["operation"],
          details: { operation: name },
        },
      );
    }

    const parsed = operation.input.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      throw new InvalidInputError(shapeRefusalMessage(operation.name, issues, caller.transport), {
        // The paths the schema objected to, so an adapter can point at
        // the fields without re-parsing the message. Deduplicated
        // because one field can raise several issues, and a caller
        // reading "title, title, title" learns nothing extra.
        fields: [
          ...new Set(issues.map((issue) => issue.path.map((segment) => String(segment)).join("."))),
        ].filter((path) => path.length > 0),
        // The findings, structured, so an adapter can render them as a
        // list rather than an adapter having to split the message back
        // apart on a separator. `fields` above answers "which fields",
        // which is a different question from "what was wrong with each" —
        // a call refused for two unrelated reasons has two entries here
        // and one line per entry in the message.
        details: { findings: findingsFrom(issues) },
      });
    }

    // Step 3 — once, here, for the whole call. Not in the operation, not
    // per guard, and not inside the transaction.
    const settings = await this.#resolveSnapshot();

    // Step 4 — the body throws to abandon the transaction. `call`'s own
    // `catch` is what normalises whatever comes out into the taxonomy and
    // logs it; there is no second catch here, on purpose.
    const result = await this.#transaction(async (db) => {
      const ctx: ServiceContext = {
        db,
        settings,
        caller,
        operation: operation.name,
      };
      return await operation.handler(ctx, parsed.data as never);
    });

    // Step 5 — a read that will not fit is refused rather than returned
    // (MILESTONES.md #115). Here rather than inside an operation because
    // this is the seam every call crosses on every adapter, so a read added
    // later is covered without its author remembering to cover it.
    //
    // **After the transaction, deliberately.** The size of a response is a
    // property of the rows that were read, which is not known until the
    // body has run — and for a read there is nothing to roll back, so
    // refusing here costs a wasted query and no correctness. Measuring
    // inside the transaction would hold it open across the serialisation of
    // the very response that is too big to serialise cheaply.
    enforceResponseSize(operation.name, operation.kind, caller.transport, result);

    // Step 6 - whatever the interventions noticed rides back beside the
    // payload (MILESTONES.md #128). Here for the same reason step 5 is
    // here: this is the one seam every call crosses on every adapter, so an
    // operation added later carries the field without its author
    // remembering to add it, and no operation's own body has to know the
    // feature exists.
    //
    // **After the size check, deliberately.** The two would otherwise
    // interact in the one direction that matters: a response measured with
    // the payload already attached could be refused for exceeding the cap
    // because of an advisory field the caller never asked for - turning a
    // nudge into a failed read. The payload is small and bounded, but
    // "small" is not an argument for measuring it, and the ordering makes
    // the question moot rather than merely unlikely.
    return this.#deliverInterventions(result, caller);
  }

  /**
   * Attaches the intervention payload, or returns the result untouched.
   *
   * Untouched is the overwhelmingly common answer, and the identity return
   * in `attachInterventions` is what makes this safe to run on every call:
   * a build with no deliverer configured, or a call that triggered nothing,
   * returns precisely the value it returned before this existed.
   *
   * **It cannot reach the database and is not given the chance to.** The
   * transaction has already closed by the time this runs, and the deliverer
   * receives no handle - which is the same contract the predicates are held
   * to, and the thing that keeps `hook_decision`'s "touches no table on the
   * ordinary path" property true of every other operation as well.
   *
   * **A deliverer that throws is swallowed.** An advisory field is never
   * worth failing a call that has already committed: the operation
   * succeeded, the transaction is closed, and the caller is entitled to its
   * result whether or not something optional could be computed alongside
   * it. This is the same fail-open reasoning DECISIONS.md sec.16 records for
   * the hook, applied at the only other place a finding can be produced.
   */
  #deliverInterventions(result: unknown, caller: Caller): unknown {
    const deliver = this.#deliverer;
    if (deliver === undefined) return result;

    try {
      return deliver(result, caller);
    } catch (error) {
      log.debug("Intervention delivery failed; returning the result unchanged.", {
        requestId: caller.requestId,
        err: error,
      });
      return result;
    }
  }
}

/** One thing wrong with an input, on its own. */
export interface ShapeFinding {
  /** The field path, or `""` for an objection to the input as a whole. */
  readonly field: string;
  readonly message: string;
}

/**
 * Every objection the schema raised, as separate findings.
 *
 * A schema can refuse one call for several unrelated reasons at once, and
 * the reasons are genuinely independent — a value outside an enum and an
 * unrecognised key are two different mistakes that happen to have arrived
 * together. Joining them into one sentence reads as a single confusing
 * complaint, and a caller who fixes the half they understood is refused
 * again on the half they did not. Kept as a list, each is a finding that can
 * be read, and fixed, on its own.
 */
function findingsFrom(issues: readonly z.ZodIssue[]): readonly ShapeFinding[] {
  return issues.map((issue) => ({
    field: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

/**
 * The message a caller reads when their input does not match the schema.
 *
 * Two things it does beyond naming the problem, both from MILESTONES.md
 * #111:
 *
 *   - **It numbers multiple faults.** One call really did once fail for two
 *     independent undocumented reasons at once, and the session read one
 *     confusing message instead of two findings. Numbered lines make the
 *     count visible, which is the part that was lost: a caller who can see
 *     there are two problems does not fix one and resubmit.
 *   - **It names the call that would have prevented it.** A caller needs the
 *     contract exactly when a call fails, and that is the moment nothing
 *     otherwise points at it. Worded for the surface the caller is actually
 *     on (`surfaces.ts`) — telling an MCP caller to run a terminal
 *     command is the defect, not the fix.
 *
 * The pointer is appended for every operation, including those declaring no
 * `contract`. A caller who has just been refused cannot know whether the
 * tool they were refused by has conditional rules, so "ask and find there
 * are none" is a cheap answer and "no pointer, work it out" is not.
 */
function shapeRefusalMessage(
  operation: string,
  issues: readonly z.ZodIssue[],
  transport: string | undefined,
): string {
  const findings = findingsFrom(issues);
  const pointer = invocationWithArgumentFor(
    "describe_tool",
    operation,
    surfaceForTransport(transport),
  );
  const head = `Invalid input for ${operation}`;
  const routing = `Call ${pointer} for the full contract, including the rules the schema cannot state.`;

  if (findings.length === 1) {
    // A single fault reads worse as a numbered list of one than as a
    // sentence, and the count is not information when it is one.
    return `${head}: ${describeFinding(findings[0]!)} ${routing}`;
  }

  const lines = findings.map((finding, index) => `  ${index + 1}. ${describeFinding(finding)}`);
  return `${head} — ${findings.length} problems:\n${lines.join("\n")}\n${routing}`;
}

/**
 * One finding as a line.
 *
 * The field is named ahead of the message because Zod's own text often does
 * not contain it — "Required" and "Unrecognized key" say what is wrong and
 * leave a caller to infer where from a path they cannot see. Prefixing costs
 * a few characters and removes the inference.
 */
function describeFinding(finding: ShapeFinding): string {
  return finding.field.length > 0 ? `\`${finding.field}\`: ${finding.message}` : finding.message;
}

/**
 * The parts of a caller that belong in a log line.
 *
 * An allowlist, not a spread of `caller`: `Caller` is a type other rows may
 * add fields to, and a spread would put every future field into the log by
 * default — which is the mechanism by which a credential eventually gets
 * logged by nobody's decision. The three named here are identifiers the
 * `events` table already stores against every write, so logging them
 * discloses nothing a reader of this installation's own data could not
 * already see. Absent keys are omitted rather than written as `undefined`,
 * so a line carries no empty fields to read past.
 */
function callerContext(caller: Caller): Record<string, string> {
  return {
    ...(caller.transport === undefined ? {} : { transport: caller.transport }),
    ...(caller.sessionId === undefined ? {} : { sessionId: caller.sessionId }),
    ...(caller.actor === undefined ? {} : { actor: caller.actor }),
  };
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
