// Reading an operation's fields off the schema it is actually rejected by.
//
// The point of walking the schema rather than writing the field list down is
// that there is nothing to keep in step. `describe_tool`'s answer about
// `create_item` comes from the same `inputSchema` object `ServiceRuntime`
// calls `safeParse` on, so a field added, renamed, made optional or given a
// new enum member is described correctly the moment it changes, and a field
// list nobody updated cannot exist.
//
// **What this deliberately does not do is reimplement JSON Schema.** The MCP
// adapter already advertises a real JSON Schema rendering (`mcp/tools.ts`),
// and a second, subtly different one here would be exactly the drift this
// module exists to avoid. This produces a short, flat, human-readable line
// per field — the thing a caller reads to answer "what do I pass" — and
// leaves nesting to the schema itself.
import type { z } from "zod";

/** One field of an operation's input, as a caller reads it. */
export interface FieldDescriptor {
  readonly name: string;
  /** A short type name: `string`, `enum`, `array<object>`, `record`. */
  readonly type: string;
  /** Whether the field may be omitted. A defaulted field may be. */
  readonly required: boolean;
  /** The permitted values, when the type is an enum. */
  readonly enumValues?: readonly string[];
  /** The value used when the field is omitted, when there is one. */
  readonly defaultValue?: unknown;
  /** Whether `null` is accepted in addition to the type. */
  readonly nullable?: boolean;
}

/** Zod's internal shape of the node kinds this module reads. */
interface ZodNode {
  readonly _def: {
    readonly typeName?: string;
    readonly innerType?: ZodNode;
    readonly schema?: ZodNode;
    readonly type?: ZodNode;
    readonly values?: readonly string[];
    readonly defaultValue?: () => unknown;
    readonly options?: readonly ZodNode[];
    readonly valueType?: ZodNode;
  };
  readonly shape?: Record<string, ZodNode>;
}

/**
 * The object node under any number of wrappers.
 *
 * `create_item` and `complete_item` both end their schemas with `.refine()`,
 * which wraps the object in a `ZodEffects` that has no `.shape` of its own —
 * the same fact `mcp/tools.ts` has to know about to advertise a schema at
 * all. Recursing rather than unwrapping once means a schema refined twice is
 * found the same way a singly-refined one is.
 */
function objectNode(schema: ZodNode | undefined): ZodNode | undefined {
  // Guarded rather than assumed to be a schema: this is called with whatever
  // an operation declared as its `input`, reached through the erased
  // `AnyOperation` type where it is only known to be able to `safeParse`.
  // Answering "no fields found" for something that is not a Zod object is
  // the same degraded-but-useful answer the caller gets for any other
  // unwalkable schema.
  if (schema === null || typeof schema !== "object") return undefined;
  if (schema.shape !== undefined) return schema;
  const inner = schema._def?.schema ?? schema._def?.innerType;
  return inner ? objectNode(inner) : undefined;
}

interface Unwrapped {
  readonly node: ZodNode;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly defaultValue?: unknown;
  readonly hasDefault: boolean;
}

/**
 * A field's own node, with the three wrappers that change how it is called
 * peeled off and recorded.
 *
 * Optionality, nullability and a default are properties of the *wrapper*,
 * not of the type, and a caller needs all three separately: `.optional()`
 * means the key may be absent, `.nullable()` means `null` is a value, and
 * `.default()` means absent is filled in — which is a different instruction
 * from "you may leave it out and nothing happens". The loop is unbounded
 * rather than fixed-depth because the wrappers compose in any order
 * (`.nullable().optional()` is as valid as the reverse).
 */
function unwrap(schema: ZodNode): Unwrapped {
  let node = schema;
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let defaultValue: unknown;
  for (;;) {
    const typeName = node._def.typeName;
    if (typeName === "ZodOptional" && node._def.innerType) {
      optional = true;
      node = node._def.innerType;
      continue;
    }
    if (typeName === "ZodNullable" && node._def.innerType) {
      nullable = true;
      node = node._def.innerType;
      continue;
    }
    if (typeName === "ZodDefault" && node._def.innerType) {
      hasDefault = true;
      defaultValue = node._def.defaultValue?.();
      node = node._def.innerType;
      continue;
    }
    if (typeName === "ZodEffects" && node._def.schema) {
      node = node._def.schema;
      continue;
    }
    break;
  }
  return { node, optional, nullable, hasDefault, defaultValue };
}

/**
 * A node's type as one word a caller can act on.
 *
 * Short names rather than Zod's own (`ZodString`), because the reader is a
 * caller deciding what to send, not someone debugging a schema. Unknown node
 * kinds fall through to `unknown` rather than throwing: a new Zod type
 * appearing in some future operation should make one line of one description
 * vaguer, not make `describe_tool` fail for the whole tool.
 */
function typeNameOf(node: ZodNode): string {
  switch (node._def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return "enum";
    case "ZodLiteral":
      return "literal";
    case "ZodArray": {
      const element = node._def.type;
      return element ? `array<${typeNameOf(unwrap(element).node)}>` : "array";
    }
    case "ZodRecord":
      return "record";
    case "ZodObject":
      return "object";
    case "ZodUnion":
      return "union";
    case "ZodDate":
      return "date";
    default:
      return "unknown";
  }
}

/**
 * Every field of an operation's input schema.
 *
 * Returns an empty list rather than throwing for a schema with no object
 * under it. An operation taking a non-object input is not currently possible
 * — every registered one takes an object — but `describe_tool` answering
 * "this tool has no documented fields" is a better failure than
 * `describe_tool` throwing, because the rules half of the answer is still
 * worth returning.
 */
export function describeFields(schema: unknown): readonly FieldDescriptor[] {
  const object = objectNode(schema as ZodNode);
  const shape = object?.shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => {
    const { node, optional, nullable, hasDefault, defaultValue } = unwrap(field);
    return {
      name,
      type: typeNameOf(node),
      // A defaulted field may be omitted, so it is not required — the
      // default is what says what happens when it is. Treating a default as
      // "required with a suggestion" would tell a caller to send a value
      // they do not need to send.
      required: !optional && !hasDefault,
      ...(node._def.values ? { enumValues: [...node._def.values] } : {}),
      ...(hasDefault ? { defaultValue } : {}),
      ...(nullable ? { nullable: true } : {}),
    };
  });
}

/** The type this module reads, for callers holding a `z.ZodTypeAny`. */
export type DescribableSchema = z.ZodTypeAny | unknown;
