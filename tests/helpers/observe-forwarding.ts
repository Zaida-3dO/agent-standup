// Runs a fold and reports what it actually handed its delegate.
//
// ── Why observing beats restating ───────────────────────────────────────
//
// The `facets`/`scores` defect survived three separate checks, and every one
// of them failed for the same structural reason: nothing compared the
// payload the FOLD BUILDS against the schema that RECEIVES it. A test
// asserting a refusal passes whether the refusal was the one it meant or a
// different one; a test comparing a builder's output to a literal passes
// when the literal is wrong in the same way the builder is.
//
// This helper closes that by invoking the fold's own handler and capturing
// the call it makes to `parseDelegateInput` — the single seam every fold in
// this codebase routes its forwarding through (`session.ts`, `score.ts`,
// `project.ts`, `create-work.ts` and `loop.ts` all do). What is captured is
// therefore not a description of the forwarding; it is the forwarding.
//
// ── Why no database is needed ───────────────────────────────────────────
//
// `parseDelegateInput` performs the delegate's `.strict()` parse BEFORE the
// delegate's handler is reached, so a wrong field name throws at that point
// and the handler never runs. That is what makes the fold's naming
// observable without a connection: the interesting failure happens strictly
// earlier than anything that would need one.
//
// To keep it that way this helper deliberately stops the call at that seam.
// The mocked `parseDelegateInput` performs the REAL parse — the same
// `safeParse` against the same schema the service uses — records the result,
// and then throws a private sentinel so no delegate handler is entered. A
// real `InvalidInputError` from a genuinely wrong payload propagates
// untouched, so a fold that forwards a bad name still fails rather than
// being swallowed by the harness.
//
// ── What a caller gets ──────────────────────────────────────────────────
//
// The delegate's registered NAME and the parsed input, which together
// answer both halves of the question a fold raises: *which* operation did
// this action reach, and *under which field names*. The first half is what
// the `FOLDED_INTO` × `FOLD_ACTIONS` cross-check consumes — a fold may
// declare it folds an operation and reach a different one entirely, and a
// map compared against another map cannot see that.
import { vi } from "vitest";

import type { ServiceContext } from "@/lib/service/context";

/** What a fold handed its delegate, as the delegate's own schema parsed it. */
export interface ForwardedCall {
  /** The delegate's registered operation name, as the fold named it. */
  readonly operation: string;
  /** The payload, after the delegate's own `.strict()` parse accepted it. */
  readonly input: unknown;
}

/**
 * Thrown to stop a fold at the forwarding seam.
 *
 * A private class rather than a string or a plain `Error`, so it can be
 * told apart from a refusal the code under test raised. Catching broadly
 * here would turn a genuine `InvalidInputError` — the exact failure this
 * harness exists to surface — into a silent pass.
 */
class ForwardingObserved extends Error {
  constructor() {
    super("forwarding observed");
    this.name = "ForwardingObserved";
  }
}

/**
 * A context with nothing in it that a fold reaches before forwarding.
 *
 * Folds do not touch `db` or `settings` on the way to their delegate — they
 * validate, they switch on the discriminator, and they forward. Anything
 * that DID reach for the database on that path would fail loudly here
 * rather than quietly passing, which is the behaviour to want: it would
 * mean the fold had grown a second implementation, the one thing every
 * fold's header promises it has not.
 */
export function stubContext(transport = "mcp_http"): ServiceContext {
  return {
    db: {
      $queryRawUnsafe: () => {
        throw new Error("a fold reached the database before forwarding — it should not");
      },
      $executeRawUnsafe: () => {
        throw new Error("a fold reached the database before forwarding — it should not");
      },
    },
    caller: { transport },
  } as unknown as ServiceContext;
}

/**
 * Invokes `handler` and returns the forwarding it performed.
 *
 * Returns every captured call rather than only the first: a fold is free to
 * forward more than once, and a harness that looked at one would report a
 * partially-correct fold as correct.
 *
 * @throws whatever the fold threw, when it threw something other than the
 * sentinel — a refusal from the delegate's own schema is the signal this
 * harness exists to deliver, not an error to absorb.
 */
export async function observeForwarding(
  handler: (ctx: ServiceContext, input: never) => Promise<unknown>,
  input: unknown,
  transport = "mcp_http",
): Promise<readonly ForwardedCall[]> {
  const shapeRefusal = await import("@/lib/service/shape-refusal");
  const seen: ForwardedCall[] = [];

  const spy = vi
    .spyOn(shapeRefusal, "parseDelegateInput")
    .mockImplementation((operation, schema, value, callerTransport) => {
      // The REAL parse, against the REAL schema, exactly as the service
      // performs it. A wrong field name raises the same refusal object here
      // that a caller would have received, and it is re-thrown rather than
      // recorded — the harness must not make a broken fold look observed.
      const parsed = actualParse(shapeRefusal, operation, schema, value, callerTransport);
      seen.push({ operation, input: parsed });
      throw new ForwardingObserved();
    });

  try {
    await handler(stubContext(transport), input as never);
  } catch (error) {
    if (!(error instanceof ForwardingObserved)) throw error;
  } finally {
    spy.mockRestore();
  }

  return seen;
}

/**
 * The unmocked parse.
 *
 * Reached through the module object rather than a direct import so that the
 * mock installed above does not call itself. `getOriginal` is not something
 * vitest exposes, so the real implementation is re-created here from the
 * same two steps `parseDelegateInput` performs — and the assertion that
 * these stay in step is `tests/fold-forwarding-names.test.ts`'s own literal
 * table, which parses the same schemas directly.
 */
function actualParse(
  module: typeof import("@/lib/service/shape-refusal"),
  operation: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  value: unknown,
  transport: string | undefined,
): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw module.invalidInputFromIssues(
      operation,
      (parsed.error as { issues: never[] }).issues,
      transport,
    );
  }
  return parsed.data;
}
