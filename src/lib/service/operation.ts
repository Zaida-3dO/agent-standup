// How one service operation is declared. See docs/plans/SCHEMA.md §22.
//
// `defineOperation` is the only way to make one, and the registry is the
// only way to reach one, so "the set of operations" is a value the process
// holds rather than a list a document claims. That matters because the
// conformance harness iterates the registry to decide what every adapter
// must expose: a list maintained by hand would be wrong the first time
// someone forgot to add a row, and the harness would report full coverage
// of a smaller set than exists.
import type { z } from "zod";
import type { ServiceContext } from "./context";

/**
 * What an operation does to the world.
 *
 * `read` and `write` are separated because §22's waiver rule turns on it:
 * an adapter may waive an operation, but no adapter exposing any write may
 * waive an operation a guard can reject — so an adapter is read-only by
 * declaration or fully covered, with nothing in between. That rule needs to
 * ask an operation which kind it is.
 */
export type OperationKind = "read" | "write";

/**
 * A declared service operation.
 *
 * The input schema lives here rather than in each adapter, which is what
 * makes "identical rejections" achievable at all: every adapter parses the
 * same schema through the same call, so an invalid input is refused with
 * the same code and the same offending fields whichever door it came in.
 */
export interface Operation<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Raw = unknown,
> {
  readonly name: Name;
  readonly kind: OperationKind;
  /** One line, as a tool description or `--help` line would read it. */
  readonly summary: string;
  /**
   * The schema. Its *parsed* type is `Input`; the type it accepts, `Raw`,
   * is a separate parameter.
   *
   * The two are not the same type and the difference is load-bearing: a
   * schema using `.default()` accepts a value that omits the field and
   * produces one where it is present. Collapsing them — the one-argument
   * `z.ZodType<Input>` — makes every such schema unassignable, so the only
   * operations that could be declared would be those whose input needs no
   * defaulting at all. `Raw` is inferred at the definition site and
   * matters to nobody downstream, because everything past `safeParse` sees
   * `Input`.
   */
  readonly input: z.ZodType<Input, z.ZodTypeDef, Raw>;
  /**
   * The body, run inside the transaction with the call's one snapshot
   * already resolved. It receives no client and opens no transaction.
   */
  readonly handler: (ctx: ServiceContext, input: Input) => Promise<Output>;
}

/**
 * Declares an operation.
 *
 * A function rather than an object literal so the name is captured as a
 * literal type: `defineOperation({ name: "get_item", ... })` has type
 * `Operation<"get_item", …>`, and the registry's key type is derived from
 * those literals. An adapter map typed by that key cannot compile while it
 * is missing an operation, which is the compile-time half of §22's
 * completeness assertion.
 */
export function defineOperation<const Name extends string, Input, Output, Raw>(
  operation: Operation<Name, Input, Output, Raw>,
): Operation<Name, Input, Output, Raw> {
  return Object.freeze(operation);
}

/**
 * The one thing the runtime asks a schema to do.
 *
 * The erased operation type below cannot say `z.ZodType<…>` for its schema:
 * Zod's class is invariant in the type it accepts, so no substitution of
 * that parameter is assignable from every concrete schema — an operation
 * taking `{ title: string }` and one taking `{}` have no common `ZodType`
 * supertype. Naming the capability instead of the class sidesteps that, and
 * is anyway the more honest statement of the dependency: the runtime parses
 * and reads issues, and uses nothing else Zod offers.
 */
export interface ParsesInput {
  safeParse(
    value: unknown,
  ):
    { success: true; data: unknown } | { success: false; error: { issues: readonly z.ZodIssue[] } };
}

/**
 * An operation with its type parameters erased, as the registry stores it.
 *
 * Erased asymmetrically, because the input appears in both a covariant
 * position (the schema) and a contravariant one (the handler's parameter):
 * parsing yields `unknown`, and the handler accepts `never`. That is honest
 * about what an erased operation can be used for — you may parse with it,
 * and you may only call it with something that parse already produced.
 */
export interface AnyOperation {
  readonly name: string;
  readonly kind: OperationKind;
  readonly summary: string;
  readonly input: ParsesInput;
  readonly handler: (ctx: ServiceContext, input: never) => Promise<unknown>;
}
