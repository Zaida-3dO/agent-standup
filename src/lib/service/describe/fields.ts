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
    // `z.enum` stores an array here; `z.nativeEnum` stores the enum *object*
    // (`{ A: "a" }`). Typing it as only an array is what let an unguarded
    // spread past the type checker, so the declaration now admits both and
    // `enumValuesOf` is the one place that resolves the difference.
    readonly values?: readonly string[] | Readonly<Record<string, string | number>>;
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
 * The permitted values of an enum node, whichever way Zod stored them.
 *
 * `z.enum(["a", "b"])` puts an array on `_def.values`; `z.nativeEnum(E)` puts
 * the enum *object* there (`{ A: "a", B: "b" }`), which is not iterable. A
 * spread that assumed the array threw a `TypeError` for the second shape —
 * and threw it from the one tool a caller reaches for *after* being refused,
 * so the failure landed on somebody already stuck.
 *
 * Reading both is the smaller claim than teaching `typeNameOf` about
 * `ZodNativeEnum`: the type name still falls through to `unknown`, which is
 * this module's documented answer for a node kind it does not model, and
 * the values are reported because they are genuinely there to report. A
 * caller is better served by `unknown` plus the real member list than by
 * either half alone.
 *
 * Returns `undefined` — not an empty array — whenever there is nothing to
 * report, so the spread at the call site adds no key at all. That covers
 * both the node with no `values` and the one whose values resolve to an
 * empty list: `enumValues: []` would claim an enum permitting nothing, which
 * is a different and wrong statement from "this field is not an enum".
 */
function enumValuesOf(node: ZodNode): readonly string[] | undefined {
  const values = node._def.values;
  if (!values) return undefined;
  if (Array.isArray(values)) return values as readonly string[];
  // A numeric TypeScript enum compiles to an object carrying its own reverse
  // mapping — `{ A: 0, B: 1, 0: "A", 1: "B" }` — and Zod accepts only the
  // forward half (`0`, not `"A"`). Taking every `Object.values` entry would
  // therefore document two members the schema rejects, which is worse than
  // documenting none. The reverse keys are dropped by the same test Zod's
  // own validator uses: a key `k` is a reverse mapping when `obj[obj[k]]` is
  // a number. Mirroring the validator is deliberate — the list a caller is
  // shown and the list they are checked against have to be the same list.
  const object = values as Record<string, string | number>;
  const members = Object.keys(object)
    .filter((key) => typeof object[object[key] as unknown as string] !== "number")
    .map((key) => String(object[key]));
  return members.length > 0 ? members : undefined;
}

/** The `enumValues` half of a descriptor, present only when there are values. */
function enumValuesEntry(node: ZodNode): { enumValues?: readonly string[] } {
  const enumValues = enumValuesOf(node);
  return enumValues ? { enumValues } : {};
}

/**
 * Every field of an operation's input schema.
 *
 * Returns an empty list rather than throwing for a schema with no object
 * under it. Every registered operation takes an object, so this is a
 * defensive path rather than one a caller reaches — but `describe_tool`
 * answering "this tool has no documented fields" is a better failure than
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
      ...enumValuesEntry(node),
      ...(hasDefault ? { defaultValue } : {}),
      ...(nullable ? { nullable: true } : {}),
    };
  });
}

/** The type this module reads, for callers holding a `z.ZodTypeAny`. */
export type DescribableSchema = z.ZodTypeAny | unknown;
