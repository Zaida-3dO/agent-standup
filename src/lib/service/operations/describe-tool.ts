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
import { currentBuildInfo, type BuildInfo } from "@/lib/build-info";

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

/**
 * What this build is, for a caller who named no tool.
 *
 * ── Why these three live here ───────────────────────────────────────────
 *
 * They were `service_info`'s, and `service_info` returned four things: a
 * catalogue of every operation, which duplicates what `tools/list` already
 * sends every client on connect, and these three, which nothing else on MCP
 * carries. `get_settings` and `get_setting` are waived off both MCP
 * transports, so once the duplicated catalogue was the only reason to keep
 * the tool, waiving it would have left **no MCP tool able to report a
 * setting value at all**. Rehoming them here is what made that waiver safe.
 *
 * ── Why this tool and not another ───────────────────────────────────────
 *
 * Not merely because it was cheap. `describe_tool` is the only remaining
 * MCP read whose subject is *the contract* rather than the data, and each
 * of these is a contract fact: `maxDepth` is the ceiling `create_work`
 * refuses a too-deep subtask against, and `waitTimeoutSeconds` is how long
 * a caller should wait before concluding nothing is coming. They belong
 * beside the other things a caller reads when asking "what will this refuse
 * me for". It is also, in practice, where a confused caller already goes —
 * which is exactly when "am I talking to the build I think I am" gets
 * asked.
 *
 * ── Why NOT on `readiness` ──────────────────────────────────────────────
 *
 * `readiness` is reached as an **unauthenticated** probe — that is the one
 * shape an MCP tool cannot be, and it is why that operation is waived. A
 * version plus a git revision on an unauthenticated route is information
 * disclosure, so the version work deliberately kept `build` off it. This
 * home is authenticated; that decision stands and is not undone here.
 */
export interface ServiceFacts {
  /** What code is actually running — version, git revision and build time. */
  readonly build: BuildInfo;
  /** Settings a caller has to respect to make a valid request. */
  readonly limits: {
    readonly maxDepth: number;
    readonly waitTimeoutSeconds: number;
  };
  /** The settings revision this answer was resolved at. */
  readonly settingsRevision: string;
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
     *
     * **Optional, and an omitted `tool` is a different question, not a
     * degenerate one.** Omitted, this returns what the build is and the
     * limits it enforces (`ServiceFacts`) rather than one tool's contract.
     * The two answers share a tool because they are the same *kind* of
     * question — "what is the contract here" — asked at two scopes, and
     * because the caller asking either is usually the caller who has just
     * been surprised.
     *
     * It is optional rather than a second tool because a second tool is a
     * second permanent entry in every session's tool list, which is the
     * cost this whole operation exists to avoid paying.
     */
    tool: z.string().trim().min(1, "tool is required").optional(),
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
    "The full contract for one tool: its fields, and the conditional rules its schema cannot state. Omit `tool` for what this build is and the limits it enforces.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: DescribeToolInput,
  ): Promise<ToolContract | ServiceFacts> {
    if (!lookup || !names) {
      // Reachable only if this operation is called without the registry
      // module having loaded, which the registry's own construction
      // prevents. `service_info` refuses the equivalent case for the
      // equivalent reason: a caller told the tool does not exist is worse
      // served than one told the question could not be answered.
      throw new NotFoundError("The tool index is unavailable.", { fields: ["tool"] });
    }

    // No tool named — the caller is asking about the build, not about one
    // operation. Answered before the lookup rather than after a failed one,
    // so an omitted `tool` never reads as a tool that could not be found.
    if (input.tool === undefined) {
      return {
        // Read per call, not captured at module load — see `currentBuildInfo`.
        build: currentBuildInfo(),
        limits: {
          maxDepth: ctx.settings.values["items.max_depth"],
          waitTimeoutSeconds: ctx.settings.values["crew.wait_timeout_seconds"],
        },
        // A string, because a revision is a bigint and JSON has no bigint —
        // an adapter that serialises the answer would throw on it.
        settingsRevision: ctx.settings.revision.toString(),
        // **Deliberately no tool list here.** `service_info` returned one
        // and it was the single reason waiving that operation was worth
        // doing: every MCP client is already sent the exposed tools on
        // connect, so a catalogue on a read duplicates what the caller
        // holds. Reproducing it here would rebuild exactly the waste being
        // removed.
        //
        // It would also be *wrong* in a way the duplicate was not. The
        // registry's name list is every REGISTERED operation, not every
        // one this adapter EXPOSES — it includes `backfill`, `loop_list`
        // and the other waived names. Returning it over MCP would name
        // tools the caller cannot call, which is the stale-advice defect
        // class this surface has already been corrected for more than once.
      };
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
