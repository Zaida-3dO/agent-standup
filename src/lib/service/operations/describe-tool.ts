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
// `originPersonId`, `complete_item`'s cardinality and conditional presence,
// `checkpoint`'s requirement of the caller's own live assignment — because
// JSON Schema cannot state "required only when", and because a check that
// reads the database is not expressible in a schema at all. Those live in
// `.refine()` calls, runtime validators and plain queries, and a client sees
// none of them.
//
// **Which is exactly why an undeclared rule is the failure mode here.** This
// operation reports what an operation DECLARES, and it cannot detect a rule
// that is enforced and undeclared — see `ToolContract.rules` for the
// incident where four operations reported no rules while refusing callers
// for rules they had.
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
import { bindingsFor } from "../describe/bindings";
import { FOLD_ACTIONS, discriminatorFor } from "../describe/fold-actions";
import { currentBuildInfo, type BuildInfo } from "@/lib/build-info";
import type { AdapterName } from "@/lib/adapters/registry";
import { waiversFor, type AdapterWaiver } from "@/lib/adapters/waivers";
import {
  compareMigrationState,
  defaultMigrationsDir,
  readPackageMigrationHistory,
  type MigrationDriftReport,
} from "@/lib/migrations/state";

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
    /**
     * Fields the schema must leave optional but something later enforces —
     * rendered onto the field descriptor so the advertised schema and the
     * `rules` below cannot contradict each other. See `OperationContract`.
     */
    readonly conditionallyRequired?: Readonly<Record<string, string>>;
  };
  readonly input: unknown;
}

/**
 * The `AdapterName` a transport implies, for the two MCP transports only.
 *
 * `ctx.caller.transport` is one of SCHEMA.md §21's five wire values
 * (`@/lib/sessions`'s `SESSION_TRANSPORTS`); `AdapterName` is `@/lib/adapters/registry`'s
 * four-member set. They are different vocabularies for a reason —
 * `surfaceForTransport` (`@/lib/surfaces`) collapses the same five down to
 * three *surfaces* for wording a refusal, which is a coarser question than
 * this one. This function answers neither of those; it answers "does this
 * transport correspond to one specific MCP adapter", which is the only
 * mapping `waiversFor` (an `AdapterName` lookup) can use. `undefined` for
 * every transport that is not an MCP one — HTTP and the two CLI bindings
 * carry no adapter waivers to report, and inventing one would say this
 * session is bound by an MCP adapter's waiver list when it is not.
 */
function mcpAdapterForTransport(transport: string | undefined): AdapterName | undefined {
  switch (transport) {
    case "mcp-http":
      return "mcp_http";
    case "mcp-stdio":
      return "mcp_stdio";
    default:
      return undefined;
  }
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
/**
 * What this call arrived on, and what that means for it.
 *
 * ── Why this belongs beside `build`, not on a tool of its own ────────────
 *
 * Same reasoning as `build`/`limits`/`settingsRevision` above: a confused
 * caller already comes here, and "what transport am I on and what does that
 * change" is the same *kind* of question as "what build am I talking to" —
 * a contract fact about this call, not about the data. The item that added
 * this field exists because neither fact was discoverable any other way: a
 * stdio session had no way to learn it was unobserved, or that a version
 * skew against the database was possible, short of hitting the wall and
 * reading a bare Prisma error.
 */
export interface TransportFacts {
  /** SCHEMA.md §21's wire value, or `null` when the call carried none (an in-process test, a script). */
  readonly transport: string | null;
  /** The MCP adapter this call arrived through, or `null` off MCP — HTTP and the CLI carry no adapter waivers. */
  readonly adapter: AdapterName | null;
  /**
   * Operations this adapter deliberately does not expose, with why.
   *
   * `null` off MCP, for the same reason `adapter` is: a waiver is a fact
   * about one specific MCP adapter's tool list, and HTTP/the CLI have no
   * such list to report gaps in.
   */
  readonly waived: readonly Pick<AdapterWaiver, "operation" | "reason">[] | null;
}

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
  /** What this call arrived on, and the MCP-specific facts that follow from it. */
  readonly transport: TransportFacts;
  /**
   * Whether this package's own migration history is current with what the
   * database has applied (DECISIONS.md §13f). See `@/lib/migrations/state`
   * for the full comparison and why a no-server install is the case this
   * matters for.
   */
  readonly migrations: MigrationDriftReport;
}

export interface ToolContract {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly summary: string;
  /**
   * How to call it on each surface it is actually bound to, so a caller is
   * not left translating.
   *
   * **A surface this operation is not reachable on is absent, not blank.**
   * Most operations are not bound everywhere — a majority are waived off
   * MCP, and roughly half have no command-line verb — so the key is omitted
   * rather than filled with a plausible guess. Read a missing `cli` as "not
   * on the command line", which is the true answer and is what an earlier
   * always-present shape had no way to say.
   */
  readonly invocation: SurfaceSpelling;
  /**
   * Every field of the input, read off the schema it is rejected by.
   *
   * Flat by design: a nested parameter renders as `array<object>` or
   * `object` and stops, because `fields.ts` deliberately does not
   * reimplement JSON Schema. **A nested field's element shape is documented
   * in `rules` instead, keyed by the field name** — either naming it
   * outright or addressing a key inside it through a dotted path such as
   * `scores.facet`. So a caller who needs the element of an `array<object>`
   * reads the rules of the same response, not a deeper type. A required
   * `array<object>` with no such rule is a documentation defect and the
   * advice sweep fails the build on it.
   */
  readonly fields: readonly FieldDescriptor[];
  /**
   * Whether an MCP caller has this tool of its own.
   *
   * False for an operation waived off every MCP adapter. Read together with
   * `foldedInto`: false WITH a fold means the behaviour is reachable under
   * another name; false WITHOUT one means it is reachable on HTTP or the
   * command line only.
   */
  readonly onMcp: boolean;
  /**
   * The tool that reaches this operation's behaviour, when it is folded.
   *
   * Present only for a folded operation. A caller refused on a name it
   * remembers gets the name it should use instead, which is the question it
   * actually has.
   */
  readonly foldedInto?: string;
  /**
   * Every verb this tool accepts, when it folds several.
   *
   * Present only for a folding tool. Listing them is what makes the
   * `action` parameter discoverable without a second call.
   */
  readonly verbs?: readonly string[];
  /**
   * The fields the named `action` cannot run without.
   *
   * Present only when an `action` was named and the tool folds. Read from
   * the same table the fold refuses from, so what is advertised and what is
   * enforced are one fact rather than two that can drift.
   */
  readonly requiredForAction?: readonly string[];
  /**
   * The rules the schema cannot express, **as the operation declares them**.
   *
   * ── Absent and empty are different answers ──────────────────────────────
   *
   * **This key is omitted entirely when the operation declares no contract**,
   * and present — possibly as `[]` — when it declares one. The two states
   * are distinguished by the presence of the key alone, because rendering
   * both as `rules: []` makes them indistinguishable — which is the whole
   * reason this shape is what it is:
   *
   *   - **`rules` absent** — the operation declares no contract at all.
   *     Nothing has been said about its preconditions, which is NOT the same
   *     as saying it has none. It may enforce something undeclared.
   *   - **`rules: []`** — the operation declares a contract that happens to
   *     carry no rules. Somebody looked and recorded that there was nothing
   *     to add.
   *
   * Even so, neither form is a warrant that no precondition exists, because
   * this operation can only report what is DECLARED. An absent key is the
   * weaker answer of the two and is the one that should prompt a reader to
   * check the source or make the call.
   *
   * ── Why the distinction is drawn at all ─────────────────────────────────
   *
   * It has produced wrong documentation twice, and both times the wrong doc
   * was followed. `checkpoint`, `release`, `heartbeat` and `claim` all
   * enforced database-backed preconditions while declaring no contract, so
   * every one reported `rules: []` — and an earlier version of this comment
   * read that as a positive answer ("nothing else to know"). Three documents
   * were corrected on the strength of it to say `checkpoint` needs no claim,
   * and three sessions were refused acting on them. `077e029` declared the
   * four missing rules and corrected this comment, but left the RENDERING
   * ambiguous, so the trap stayed live for every other undeclared operation.
   *
   * The Patrick operating manual records the same trap from the other side:
   * its `checkpoint` entry flipped twice and now carries a standing warning
   * that `rules` is "evidence of presence, never of absence". **A field that
   * needs a permanent warning not to believe it is a design defect**, and
   * the fix is to stop the two states rendering identically rather than to
   * keep writing the warning down.
   *
   * ── Why omission rather than a marker ───────────────────────────────────
   *
   * It costs zero bytes on the common path, which matters for a call this
   * operation's own header says is made constantly and whose waiver
   * reasoning complains that "twenty of these spend context on every
   * session". An added `rulesDeclared: false` would spend bytes on every
   * response to say what an absent key already says. It also matches the
   * precedent set one field below: `examples` is omitted rather than empty
   * for exactly this reason — "so a caller can tell 'no further shapes' from
   * 'this field exists and is empty'".
   *
   * The remedy for an undeclared rule is still on the operation, not here:
   * an operation that refuses for a reason its schema cannot carry declares
   * that reason beside the check, and `tests/describe-tool.test.ts` holds
   * the assertions that keep the known ones present.
   */
  readonly rules?: readonly OperationRule[];
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
    /**
     * Which verb of a folded tool to describe.
     *
     * A folded tool takes its verb as a field, so "what does `loop`
     * require?" has no single answer — `add` needs `text`, `close` needs
     * `loopId`. Naming the action narrows the answer to the call the caller
     * is actually about to make.
     *
     * Ignored for a tool that folds nothing, rather than refused: a caller
     * that passes one by habit is not making an error worth a round trip,
     * and the answer it gets is the same answer it wanted.
     */
    action: z.string().trim().min(1).optional(),
  })
  .strict();

export type DescribeToolInput = z.infer<typeof inputSchema>;

/**
 * Every migration Prisma's own ledger records as finished and not rolled
 * back, by name.
 *
 * The same table `readiness.ts`'s `MIGRATION_QUERY` reads, selecting the
 * one column that operation has no use for: `readiness` counts rows to
 * answer "is anything mid-flight", where this needs each migration's own
 * name to compare against the package's history (`@/lib/migrations/state`).
 * Two queries against one table rather than widening `readiness`'s, because
 * the two operations ask genuinely different questions of the same ledger
 * and `readiness` is reached unauthenticated (this operation's own header,
 * "Why NOT on readiness") — it must not grow a reason to change for this
 * row's sake.
 */
const APPLIED_MIGRATIONS_QUERY = `
  SELECT "migration_name" AS name
  FROM "_prisma_migrations"
  WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
`;

interface RawAppliedMigrationRow {
  readonly name: string;
}

/**
 * The migration-drift report for this call, read fresh each time.
 *
 * Two failure-tolerant reads, not one: the package's own history is a
 * filesystem read that may find nothing (`readPackageMigrationHistory`'s own
 * header), and the database read below can fail for the ordinary reasons a
 * query can fail. Neither failure is this operation's to refuse over —
 * `compareMigrationState` already treats an unreadable package history as
 * `severity: "none"` rather than inventing drift, and a database read that
 * throws is left to throw, the same as `readiness.ts`'s own probe: a caller
 * told the database is unreachable learns more than one told a plausible
 * lie about its migration state.
 */
async function migrationDriftReport(ctx: ServiceContext): Promise<MigrationDriftReport> {
  const packageHistory = readPackageMigrationHistory(defaultMigrationsDir());
  const rows = await ctx.db.$queryRawUnsafe<RawAppliedMigrationRow[]>(APPLIED_MIGRATIONS_QUERY);
  return compareMigrationState(
    packageHistory,
    rows.map((row) => ({ name: row.name })),
  );
}

/** The transport facts for this call — `TransportFacts` populated from `ctx.caller`. */
function transportFacts(ctx: ServiceContext): TransportFacts {
  const transport = ctx.caller.transport ?? null;
  const adapter = mcpAdapterForTransport(ctx.caller.transport) ?? null;
  return {
    transport,
    adapter,
    waived:
      adapter === null
        ? null
        : waiversFor(adapter).map(({ operation, reason }) => ({ operation, reason })),
  };
}

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
  contract: {
    rules: [
      {
        // Attributed to `tool` — the field this operation's whole answer
        // turns on — because `OperationRule.fields` must name at least one
        // real field of the described operation (`findRuleFieldDefects`,
        // and "gives every declared rule a non-empty statement and at least
        // one field" in tests/describe-tool.test.ts). The rule itself is
        // about the transport, not about `tool`'s value, but this call is
        // where a caller reads it, so it is attributed to the call it rides
        // on rather than left with nothing to attribute to.
        fields: ["tool"],
        // Stated in the contract rather than only in a doc comment because
        // the caller who needs it is reading this response, not this file —
        // the same standard the `list_repos` decision set. Without it a
        // reader has to infer what an absent key means, which is the
        // inference that produced two wrong documents.
        rule:
          "`rules` is ABSENT when the described operation declares no contract, and PRESENT " +
          "(possibly as an empty array) when it declares one. Absent means nothing was said " +
          "about its preconditions; empty means a contract exists and adds no rule. NEITHER " +
          "is a warrant that the operation has no preconditions — this call reports only what " +
          "is declared, and an operation can enforce a database-backed check it never " +
          "declared. Read `rules` as evidence of presence, never of absence: to establish " +
          "that something is not required, read the operation's source or make the call.",
      },
      {
        fields: ["tool"],
        rule:
          'A transport-level failure ("Unable to connect") is raised by your MCP client ' +
          "before the request reaches this server, so no response carries `retryable`. " +
          "Retry an identical call ONCE. If the retry also fails, the endpoint is genuinely " +
          "unreachable — stop and report rather than investigating local networking. " +
          "For a failure that DID reach the server, read `retryable` on the rejection " +
          "instead. A retry is safe for reads; for writes see `committed`, which outranks " +
          "`retryable` because these writes are append-only with no dedupe.",
      },
    ],
  },
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
        transport: transportFacts(ctx),
        migrations: await migrationDriftReport(ctx),
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

    const bindings = bindingsFor(found.name);
    const fold = FOLD_ACTIONS.get(found.name);

    // An action named against a tool that folds must be one of its verbs.
    // Refused with the FULL list rather than a bare "unknown action": a
    // caller reaching here has a verb that is wrong, and the likely cause is
    // a near miss — the spelling from another surface, or the operation name
    // it was folded from. Denying without the list makes finding the right
    // one a second call, which is the cost this whole operation exists to
    // avoid.
    if (input.action !== undefined && fold !== undefined && !fold.actions.includes(input.action)) {
      const field = discriminatorFor(found.name);
      throw new NotFoundError(
        `No such ${field} on \`${found.name}\`: ${input.action}. ` +
          `Known ${field}s: ${fold.actions.join(", ")}.`,
        {
          fields: ["action"],
          details: { tool: found.name, action: input.action, known: fold.actions },
        },
      );
    }

    return {
      name: found.name,
      kind: found.kind,
      summary: found.summary,
      invocation: spellingsFor(found.name, bindings),
      // The operation's own `conditionallyRequired` map rides along, so a
      // field the schema must leave optional — because what makes it
      // required is resolved after the parse — is not advertised as plainly
      // optional while the `rules` below call it required in practice. That
      // contradiction within one payload is what this closes; the schema is
      // the half a caller reads first.
      fields: describeFields(found.input, found.contract?.conditionallyRequired),
      // Read off the same tables the system dispatches and refuses from, so
      // a caller is told what is true rather than what was once written
      // down. `onMcp` is always present because false is a real answer; the
      // rest are spread-or-absent, because "this tool folds nothing" and
      // "this tool folds these" are different answers and an empty list
      // would collapse them.
      onMcp: bindings.onMcp,
      ...(bindings.foldedInto === undefined ? {} : { foldedInto: bindings.foldedInto }),
      ...(fold === undefined ? {} : { verbs: fold.actions }),
      ...(input.action !== undefined && fold !== undefined
        ? { requiredForAction: fold.requiredByAction[input.action] ?? [] }
        : {}),
      // Spread-or-nothing, not `?? []`. An operation that declares no
      // contract omits the key; one that declares a contract carries its
      // rules even when the list is empty. Those are different answers —
      // "nothing was said" versus "somebody looked and there was nothing to
      // add" — and collapsing them to `[]` is what let an undeclared rule
      // read as an absent one. See `ToolContract.rules`.
      ...(found.contract === undefined ? {} : { rules: found.contract.rules }),
      ...(found.contract?.example === undefined ? {} : { example: found.contract.example }),
      ...(found.contract?.examples === undefined ? {} : { examples: found.contract.examples }),
    };
  },
});
