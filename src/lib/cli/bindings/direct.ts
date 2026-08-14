// The `direct` binding — the service layer, in this process (SCHEMA.md §20).
//
// "Otherwise it uses `DATABASE_URL` and runs the service layer in-process."
// This is that: one `service.call`, with the thrown refusal normalised into
// the `Rejection` shape the `Binding` interface promises.
//
// It imports no database client. It cannot: the runtime it calls is
// constructed in `@/lib/service/live`, which is the one module allowed to
// reach the client, and that boundary is enforced independently of this
// file's good intentions (`scripts/check-db-import-allowlist.mjs`). A
// binding is still an adapter, and "every adapter is a thin shell over a
// service call" applies to the binding that happens to run in the same
// process as the service just as much as to the one that does not.
import { isRehearsalRollback, toServiceError } from "@/lib/service";
import { log, newRequestId } from "@/lib/log";
import { bindingOk, bindingRejected, type Binding, type BindingResult } from "../binding";

/** The narrow slice of the service runtime a binding uses. */
export interface CallableService {
  call(
    name: string,
    input: unknown,
    options?: {
      caller?: { sessionId?: string; actor?: string; transport?: string; requestId?: string };
    },
  ): Promise<unknown>;
}

export interface DirectBindingOptions {
  /**
   * The runtime to call. A parameter rather than a module-level import of
   * `@/lib/service/live` so a test can drive this binding without a
   * database — and so the composition root stays the one file that decides
   * which runtime a process holds.
   */
  readonly service: CallableService;
  /** The session the command acts as, stamped onto every call. */
  readonly sessionId?: string;
  /** The person or agent the session acts as. */
  readonly actor?: string;
}

/**
 * Builds the in-process binding.
 *
 * `transport: "cli"` is stamped here, not taken from the caller: SCHEMA.md
 * §21 makes the registration transport a *capability signal* — "stamped by
 * the adapter, not supplied by the caller" — so a command cannot claim to
 * have arrived over a transport it did not.
 */
export function createDirectBinding({ service, sessionId, actor }: DirectBindingOptions): Binding {
  const caller = {
    transport: "cli",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actor === undefined ? {} : { actor }),
  };

  return {
    name: "direct",
    async invoke(operation: string, input: unknown): Promise<BindingResult> {
      // Minted at the boundary, like every other adapter's. The command
      // line is the adapter where this matters least — one caller, one
      // command — and it is stamped anyway, because a `--direct` command
      // run against a shared database writes lines into the same stream as
      // every other caller, and "which of these is mine" is the same
      // question there as anywhere else.
      const requestId = newRequestId();
      try {
        return bindingOk(
          await service.call(operation, input, { caller: { ...caller, requestId } }),
        );
      } catch (error) {
        // `transition_item`'s `dryRun` branch always throws
        // `RehearsalRollback` to abandon its own transaction, even when the
        // move it rehearsed would have been *allowed* — see that class's
        // own doc in `service/operations/rehearsal-rollback.ts`. That throw
        // is not a refusal; it is how a rehearsal reports the outcome it
        // computed. The HTTP route unwraps the identical throw into a 200
        // `{ outcome }` body (`app/api/items/[id]/transition/route.ts`) —
        // this is the same unwrapping for the binding that runs the service
        // layer in this process instead of calling out to one over HTTP.
        // Falling through to the generic handling below would report every
        // `--dry-run` call as an `internal` failure, allowed or rejected
        // alike, instead of the preview it exists to show.
        if (isRehearsalRollback(error)) {
          return bindingOk({ outcome: error.outcome });
        }
        // `toServiceError` is what keeps the promise that everything
        // leaving here is in the taxonomy: a driver error or a TypeError
        // becomes `internal` rather than escaping as an unclassifiable
        // throw that the `http` binding would have reported as a 500 and
        // this one would have reported as a crash.
        const serviceError = toServiceError(error);
        // The command line's half of #97. A failure here reached no log at
        // all: `bindingRejected` carries only the comparable part of the
        // refusal plus the fixed message, and `main` renders an `internal`
        // as its *class* and nothing more — deliberately, since a terminal
        // must not be shown a connection string. So the `cause` had nowhere
        // to go and a person debugging a failing command had only the class
        // name.
        //
        // **On stderr, at every level, including this one.** `log.error`
        // writes to stderr by construction (`lib/log.ts`), which is what
        // keeps this off the stream a command's actual output goes to —
        // `standup ... --json | jq` must not receive a log line, and a
        // shell pipeline is the most likely thing in this whole application
        // to mistake one for a result.
        if (serviceError.code === "internal") {
          log.error("Command failed unexpectedly.", {
            requestId,
            transport: caller.transport,
            operation,
            err: serviceError,
          });
        } else {
          log.debug("Command refused.", {
            requestId,
            transport: caller.transport,
            operation,
            code: serviceError.code,
            ...(serviceError.guard === undefined ? {} : { guard: serviceError.guard }),
          });
        }
        return bindingRejected(serviceError.toRejection(), serviceError.message);
      }
    },
  };
}
