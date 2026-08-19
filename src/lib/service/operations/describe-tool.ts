// `describe_tool` — one tool's full contract, on demand. MILESTONES.md #111.
//
// ── Why this is a call and not a longer description ─────────────────────
//
// A tool's description is sent to the model on every turn, so anything added
// to one is charged to every session for the lifetime of the installation,
// whether or not it is ever read (PLAN.md; the same reasoning that keeps
// `backfill` off the MCP tool list, `adapters/waivers.ts`). The conditional
// rules a caller needs are long and needed rarely — usually once, by a
// caller who has just been refused. A call pays for them only then.
//
// ── What is actually missing, which is narrower than it looks ───────────
//
// The advertised `inputSchema` is complete and correct: a live `tools/list`
// carries every operation's real fields, enums and required list, and
// `advertisedSchema` (`mcp/tools.ts`) exists to keep that true. So this
// operation is not a workaround for an invisible schema. What no schema can
// carry is the conditional rules — `create_item`'s `originType: "person"` →
// `originPersonId`, `complete_item`'s cardinality and conditional presence —
// because JSON Schema cannot state "required only when", and because a check
// that reads the database is not expressible at all. Those live in
// `.refine()` calls and runtime validators, and a client sees neither.
//
// ── Why the answer is derived ───────────────────────────────────────────
//
// Fields come from the operation's own `input` schema — the same object
// `ServiceRuntime` rejects by — and rules come from the `contract` declared
// beside the check that enforces them. Neither is a list written out here.
// A hand-maintained catalogue of every tool's fields would be a second
// source of truth whose first act would be to drift from the first, and it
// would drift silently, because nothing fails when documentation is wrong.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation, type OperationRule } from "../operation";
import type { ServiceContext } from "../context";
import { describeFields, type FieldDescriptor } from "../describe/fields";
import { spellingsFor, type SurfaceSpelling } from "@/lib/surfaces";

/**
 * Set by the registry once it has built the index.
 *
 * The same indirection `service_info` uses, for the same reason: the
 * registry imports every operation, so an operation importing the registry
 * back would be a cycle. A function the registry installs lets this
 * operation read the index without depending on the module holding it.
 */
type ToolLookup = (name: string) => ToolSource | undefined;
type ToolNames = () => readonly string[];

/** What this operation needs of an operation, so the registry's shape is not imported. */
export interface ToolSource {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly summary: string;
  readonly contract?: {
    readonly rules: readonly OperationRule[];
    readonly example?: unknown;
    readonly examples?: readonly unknown[];
  };
  readonly input: unknown;
}

let lookup: ToolLookup | null = null;
let names: ToolNames | null = null;

export function provideToolIndex(source: { lookup: ToolLookup; names: ToolNames }): void {
  lookup = source.lookup;
  names = source.names;
}

export interface ToolContract {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly summary: string;
  /** How to call it on each surface, so a caller is not left translating. */
  readonly invocation: SurfaceSpelling;
  /** Every field of the input, read off the schema it is rejected by. */
  readonly fields: readonly FieldDescriptor[];
  /**
   * The rules the schema cannot express. Empty for a tool fully described by
   * its schema — an empty list is a real answer ("nothing else to know"),
   * not a missing one.
   */
  readonly rules: readonly OperationRule[];
  /** A minimal call satisfying every rule, when the operation declares one. */
  readonly example?: unknown;
  /**
   * Further complete calls, when one example cannot represent the operation
   * — see `OperationContract.examples`. Absent when the operation declares
   * none, rather than being an empty array, so a caller can tell "no further
   * shapes" from "this field exists and is empty".
   */
  readonly examples?: readonly unknown[];
}

const inputSchema = z
  .object({
    /**
     * The tool to describe. Named `tool` rather than `name` because the
     * caller is holding a tool name — the thing they were refused on — and
     * a parameter called `name` invites them to wonder whose.
     */
    tool: z.string().trim().min(1, "tool is required"),
  })
  .strict();

export type DescribeToolInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const describeTool = defineOperation({
  name: "describe_tool",
  kind: "read",
  // One line, because this description is itself charged to every turn —
  // the cost this operation exists to avoid applies to its own entry in the
  // tool list as much as to any other.
  summary:
    "The full contract for one tool: its fields, and the conditional rules its schema cannot state.",
  // Stryker restore all
  input: inputSchema,
  async handler(_ctx: ServiceContext, input: DescribeToolInput): Promise<ToolContract> {
    if (!lookup || !names) {
      // Reachable only if this operation is called without the registry
      // module having loaded, which the registry's own construction
      // prevents. `service_info` refuses the equivalent case for the
      // equivalent reason: a caller told the tool does not exist is worse
      // served than one told the question could not be answered.
      throw new NotFoundError("The tool index is unavailable.", { fields: ["tool"] });
    }

    const found = lookup(input.tool);
    if (!found) {
      // The known names are listed rather than merely denied. A caller
      // reaching here has a name that is wrong, and the overwhelmingly
      // likely cause is a near miss — a spelling from another surface, or a
      // remembered name that has since changed. Denying without the list
      // makes finding the right one a second call.
      throw new NotFoundError(`No such tool: ${input.tool}. Known tools: ${names().join(", ")}.`, {
        fields: ["tool"],
        details: { tool: input.tool, known: names() },
      });
    }

    return {
      name: found.name,
      kind: found.kind,
      summary: found.summary,
      invocation: spellingsFor(found.name),
      fields: describeFields(found.input),
      rules: found.contract?.rules ?? [],
      ...(found.contract?.example === undefined ? {} : { example: found.contract.example }),
      ...(found.contract?.examples === undefined ? {} : { examples: found.contract.examples }),
    };
  },
});
