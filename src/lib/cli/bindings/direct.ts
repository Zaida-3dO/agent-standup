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
import { toServiceError } from "@/lib/service";
import { bindingOk, bindingRejected, type Binding, type BindingResult } from "../binding";

/** The narrow slice of the service runtime a binding uses. */
export interface CallableService {
  call(
    name: string,
    input: unknown,
    options?: { caller?: { sessionId?: string; actor?: string; transport?: string } },
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
      try {
        return bindingOk(await service.call(operation, input, { caller }));
      } catch (error) {
        // `toServiceError` is what keeps the promise that everything
        // leaving here is in the taxonomy: a driver error or a TypeError
        // becomes `internal` rather than escaping as an unclassifiable
        // throw that the `http` binding would have reported as a 500 and
        // this one would have reported as a crash.
        const serviceError = toServiceError(error);
        return bindingRejected(serviceError.toRejection(), serviceError.message);
      }
    },
  };
}
