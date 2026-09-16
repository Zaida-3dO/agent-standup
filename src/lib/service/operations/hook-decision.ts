// `hook_decision` — MILESTONES.md #125, SCHEMA.md §19 `POST /hook`.
//
// **The server side of a hook that carries no logic.** The script reports an
// event and renders whatever comes back (`src/lib/hook/decide.ts`); this
// operation is the only party that decides anything, which is the whole
// point of the arrangement: every rule anyone actually wants is conditional
// on state — item state, claim state, review artifacts, budget — and that
// state is here and can never be in a script.
//
// ── What it answers ────────────────────────────────────────────────────
//
// **It consults the intervention registry** (#128, `src/lib/interventions/`,
// `docs/plans/INTERVENTIONS.md`). The pattern lists this operation used to
// match against are deleted (#125) because matching command strings could
// not express a single one of the real rules, all of which are of the form
// *never do X **without** Y* — and the Y lives in item state, claim state
// and review artifacts, which are here and can never be in a script.
//
// The registry returns findings; this maps them onto the wire:
//
//   - a blocking finding on a `pre` event → `block`, carrying the reason;
//   - anything else → `allow`, carrying a nudge's message when there is one.
//
// ── `post` can never block, enforced in four places now ────────────────
//
// The hook enforces it (`canBlock` in `src/lib/hook/decide.ts`) and so does
// this operation, and the registry enforces it twice more — clamping a
// blocking *override* and a blocking *predicate verdict* down to a nudge.
// Four checks for one invariant is deliberate and is not the "two
// implementations that can disagree" DECISIONS.md §4 warns about: none of
// them can produce a block on a `post` event, so breaking the rule takes
// all four being wrong at once. Here the enforcement is structural — the
// `post` branch returns before the registry's level is ever consulted.
//
// ── Fail-open, revisited as DECISIONS.md §16 requires ──────────────────
//
// §16 records that the hook fails open and says outright that "row #128
// must revisit it for `pre` once real blocking exists". It exists now, and
// **the posture is deliberately unchanged.**
//
// The argument for that is not inertia. What fail-open protects against is
// a server hiccup killing *every tool call in every session*, and the
// asymmetry that made it right is untouched by this row: the rules now
// enforced are a handful of situations out of the whole traffic of a
// session, so an outage that denied everything would refuse thousands of
// calls that every one of these entries would have allowed — including the
// `Edit` that would unwire the hook. What has changed is only that some
// calls are now refused *when the server does answer*, which is exactly the
// case fail-open was never about.
//
// The residual risk is stated rather than hidden: during an outage an
// unreviewed merge would go through. That is accepted, because the guard it
// bypasses is not the only one — `transition_item` still refuses to move an
// item to `merged` without an approving review at tip, and that refusal
// happens in a transaction rather than in a hook that may not be installed.
//
// ── What it costs, which is the reason for the shape of `assembleContext` ──
//
// A decision made on every tool call is the highest-volume path in the
// system, and this operation is shaped around that. `assembleContext` gates
// every query it makes behind a command-shape test that runs against a
// string already in memory, so a `Read`, an `ls` or an `Edit` reaches no
// table through it at all — a query happens only for a command that could
// actually be the subject of a finding, which is rare by construction.
//
// **The one read that is not gated on the command is the displacement
// check**, and the asymmetry is deliberate rather than an oversight. Whether
// a session still owns its work is a fact about the *session*; a displaced
// agent's next call is overwhelmingly likely to be something ordinary, so a
// command-shape gate would skip precisely the case the check exists for. It
// is gated on the phase instead — only `PreToolUse`, the only phase that can
// act on the answer — and costs one lookup on an index that already exists
// for the claim read. See `../session-displacement.ts` for the full
// accounting.
//
// So a `PreToolUse` costs at most one index lookup, and a `PostToolUse` pays
// nothing for it at all. The operation is declared `kind: "read"`, and
// honestly so.
//
// **A `Stop` is the one event that now costs two reads unconditionally**,
// and the exception is affordable for a reason that does not generalise: a
// stop happens once per turn, not once per call. The volume argument above
// is about the thousands of tool calls inside a turn; the two queries here
// ride an event that occurs at the end of one, so they are some five orders
// of magnitude rarer than the path the gating discipline exists to protect.
// Gating them on anything would mean gating on a command a `Stop` does not
// carry. See the `Stop` branch in the handler.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { assembleContext } from "@/lib/interventions/context";
import { assembleStopContext, type StopContextPayload } from "@/lib/interventions/stop-context";
import {
  assembleWindDownContext,
  type WindDownContextPayload,
} from "@/lib/interventions/wind-down-context";
import { evaluate, strongestLevel } from "@/lib/interventions/registry";
import {
  readInterventionSettingRows,
  resolveInterventionSettings,
} from "@/lib/interventions/settings";
import {
  isBlockingLevel,
  type InterventionContext,
  type InterventionFinding,
  type InterventionOverride,
  type InterventionPhase,
} from "@/lib/interventions/types";
import { displacementFor, type SessionEnforcementPayload } from "../session-displacement";

const EVENT_TYPES = ["PreToolUse", "PostToolUse", "Stop"] as const;

const inputSchema = z
  .object({
    eventType: z.enum(EVENT_TYPES),
    sessionId: z.string().min(1),
    /** The tool the hook observed, e.g. `Bash`. Absent for a `Stop` event. */
    tool: z.string().min(1).optional(),
    /** The command text the call carried. Absent for a `Stop` event. */
    command: z.string().optional(),
    /**
     * What the tool produced, on a `PostToolUse`. Bounded by the hook
     * before it is sent; bounded again here because an operation must not
     * trust its caller to have applied a limit the caller could change.
     */
    toolResult: z.string().max(8000).optional(),
  })
  .strict();

export type HookDecisionOperationInput = z.infer<typeof inputSchema>;

/** The two things this operation can say. Only `block` refuses. */
export const HOOK_DECISIONS = ["allow", "block"] as const;
export type HookDecision = (typeof HOOK_DECISIONS)[number];

export interface HookDecisionOperationOutput {
  readonly decision: HookDecision;
  /**
   * Why, when there is a why. `null` on the ordinary allow — a reason on
   * every call would put a line of noise into a session after every Read
   * the agent performs.
   */
  readonly reason: string | null;
  /**
   * Whether this phase could have blocked at all. Carried so a caller
   * reading a log can tell "nothing objected" apart from "something might
   * have, but the phase cannot refuse" without re-deriving the rule.
   */
  readonly canBlock: boolean;
  /**
   * The findings behind the answer, in registry order.
   *
   * Present even on an `allow`, because a nudge is a finding that allows —
   * and because "nothing triggered" and "something triggered and it was
   * only advice" are different facts that a caller reading a decision log
   * has no other way to tell apart. Empty when nothing triggered.
   *
   * Note this deliberately carries the whole finding rather than a rendered
   * string: prominence is a property of the message and the choice between
   * `plain` and `prominent` belongs to the front end (`INTERVENTIONS.md`),
   * so an operation that flattened them here would be making that decision
   * on the reader's behalf and hiding the other half.
   */
  readonly findings: readonly InterventionFinding[];
  /**
   * What the server holds true about the calling session itself, when that
   * is anything other than the ordinary case.
   *
   * Absent for almost every call, and absent rather than `null` or a
   * `status: "active"` object, because the hook reads an absent field as
   * "nothing said about this session" and proceeds. Saying `active`
   * explicitly would be a claim this operation cannot make — it looks for
   * one specific fact, not for every reason a session might be unfit to
   * act.
   *
   * This is a fact about the *session* rather than about the call, which is
   * why it sits beside `decision` instead of arriving as a finding: a
   * finding is the registry's verdict on what was run, and no command a
   * displaced session could run would be the reason to stop it.
   */
  readonly enforcement?: SessionEnforcementPayload;
  /**
   * What the stop catch needs to know, on a `Stop` event.
   *
   * **A wire contract with `../../hook/stop-catch.ts`'s `readStopContext`**,
   * which parses this block field by field and drops anything it does not
   * recognise. A renamed field here is therefore not a type error anywhere —
   * it is a catch that silently never fires again, so the names are fixed by
   * the reader rather than chosen here.
   *
   * Absent on every other event type, and absent on a `Stop` whose facts
   * could not be established. It carries counts and flags only: nothing in
   * it can refuse the stop, and `decision` is `allow` on this branch
   * whatever it says.
   */
  readonly stop?: StopContextPayload;
  /**
   * What the session-end survey needs to know, on a `Stop` event — the
   * owner's scoring loop.
   *
   * **A wire contract with `../../hook/stop-catch.ts`'s
   * `readWindDownContext`**, on exactly the terms `stop` above is one: the
   * client parses this block field by field and drops anything it does not
   * recognise, so a renamed field is not a type error anywhere — it is a
   * survey that silently never fires again.
   *
   * Absent on every other event type, and absent on a `Stop` where the
   * session has nothing unrated to be asked about, which is the
   * overwhelmingly common case. It carries firings, counts and flags only:
   * nothing in it can refuse the stop, and `decision` is `allow` on this
   * branch whatever it says.
   *
   * **It deliberately does not carry `idleMs`.** The server cannot measure
   * it — see `@/lib/interventions/wind-down-context` for why each candidate
   * timestamp is wrong in the dangerous direction — so the client supplies
   * that half from its own spool and the two are merged there.
   */
  readonly windDown?: WindDownContextPayload;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const hookDecision = defineOperation({
  name: "hook_decision",
  kind: "read",
  summary: "Answers one hook event with allow or block, and any advisory text to surface.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: HookDecisionOperationInput,
  ): Promise<HookDecisionOperationOutput> {
    const canBlock = input.eventType === "PreToolUse";

    // `Stop` carries no tool call at all, so there is nothing for a
    // predicate keyed on a command or a tool to be about. Answered before
    // the registry rather than by letting every predicate decline in turn:
    // an advisory event (DECISIONS.md §6) that assembled a context and
    // walked the catalogue would be spending the highest-volume path's
    // budget to reach a conclusion the phase already determines.
    if (input.eventType === "Stop") {
      // **The registry is still not consulted, and that is unchanged.** A
      // `Stop` carries no tool and no command, so every predicate keyed on
      // one would decline in turn — walking the catalogue to reach a
      // conclusion the phase already determines is the cost this early
      // return exists to avoid.
      //
      // What a `Stop` does now carry is the stop catch's own context, which
      // is a different question from any the catalogue asks: not "should
      // this call be refused" but "is anyone still working for you". It is
      // assembled here because this is the only server-side moment that
      // sees a stop at all — `../../hook/stop-catch.ts` has been able to
      // read this block since it was written, and nothing has ever sent
      // one.
      //
      // **`decision` stays `allow` unconditionally**, and no value this
      // block can take is consulted before returning it. DECISIONS.md §6:
      // a refused stop can trap an agent in a loop, so the advisory
      // property is structural here rather than a rule to remember.
      const stop = await assembleStopContext({
        db: ctx.db,
        sessionId: input.sessionId,
        deadAfterSeconds: ctx.settings.values["liveness.dead_after_seconds"],
        waitTimeoutMaxSeconds: ctx.settings.values["crew.wait_timeout_seconds"],
      });

      // The session-end survey's context — the owner's scoring loop, and
      // the same omission as the catch's one feature over: everything on
      // both sides of this block was built and nothing ever sent one.
      //
      // **Assembled only when the stop block was**, and it reuses that
      // block's two counts rather than re-deriving them. Both halves ask
      // the identical question — "is anyone still working for you, and is
      // anything going to wake you" — so computing them twice would be two
      // definitions of one fact, and the pair would disagree the first time
      // either query was tuned. It would also double the cost of the `Stop`
      // path to reach the same answer.
      //
      // When `stop` is `undefined` the crew facts are unknown rather than
      // zero (see `assembleStopContext`), and passing an unknown along as
      // `liveCrew: 0` would be manufacturing exactly the settled fact that
      // producer refused to state. So the survey stays silent too, which is
      // the honest reading of a question that was not successfully asked.
      const windDown =
        stop === undefined
          ? undefined
          : await assembleWindDownContext({
              db: ctx.db,
              sessionId: input.sessionId,
              deadAfterSeconds: ctx.settings.values["liveness.dead_after_seconds"],
              liveCrew: stop.liveCrew,
              wakeScheduled: stop.wakeScheduled,
            });

      return {
        decision: "allow",
        reason: null,
        canBlock,
        findings: [],
        // Absent rather than a zeroed block when nothing could be
        // established — the client reads an absent block as "not known" and
        // stays silent, which is the correct answer to a question that was
        // not successfully asked.
        ...(stop === undefined ? {} : { stop }),
        // Absent on the overwhelmingly common stop, where the session has
        // nothing unrated. That absence is the whole of "a session with no
        // firings produces no survey and no noise".
        ...(windDown === undefined ? {} : { windDown }),
      };
    }

    // Whether this session still owns the work it is doing — see
    // `../session-displacement.ts` for why the answer travels here and what
    // it costs.
    //
    // **Gated on the phase, and only on the phase.** Displacement is a fact
    // about the session, so it cannot be gated on the command's shape the
    // way the intervention context gates its own reads: a displaced agent's
    // next call is overwhelmingly likely to be an ordinary `Read`, which is
    // precisely the call such a gate would skip. The phase costs nothing to
    // test and is the honest limit — a `PostToolUse` describes a call that
    // has already run, and the hook independently refuses to block on it, so
    // a notice sent there would be discarded on arrival rather than acted
    // on.
    const enforcement = canBlock ? await displacementFor(ctx.db, input.sessionId) : undefined;

    const context = await assembleContext({
      db: ctx.db,
      sessionId: input.sessionId,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.command === undefined ? {} : { command: input.command }),
      // The phase decides whether I14's window is read at all — it is a
      // `post` entry, so on a `PreToolUse` the reading would be paying for a
      // verdict the registry is never going to ask for.
      phase: canBlock ? "pre" : "post",
      handsOn: {
        minimumSample: ctx.settings.values["shape.minimum_sample"],
        editThreshold: ctx.settings.values["interventions.hands_on_edit_threshold"],
        window: ctx.settings.values["interventions.hands_on_window"],
      },
      // The crew-in-flight count's liveness bound — the same
      // `liveness.dead_after_seconds` the Fleet page reads, passed through
      // rather than defaulted so that one configured threshold governs both
      // screens. See `crewInFlightFor`.
      crewInFlightDeadAfterSeconds: ctx.settings.values["liveness.dead_after_seconds"],
    });

    // The installation's own configuration, read only when a finding is
    // possible at all. `assembleContext` leaves every item-shaped field
    // absent for a call that could not be the subject of one, and such a
    // call cannot produce a finding for an override to apply to — so
    // reading the rows for it would put a query on the highest-volume path
    // to configure a verdict that is not going to be reached.
    const overrides = await readOverridesIfUseful(ctx, context, canBlock ? "pre" : "post");

    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      overrides,
      // The phase is read off the event, never off the entry. That is what
      // makes "a post entry cannot block" structural here: on a
      // `PostToolUse` the registry is only ever asked for `post` entries,
      // and every `post` entry's level is already clamped below blocking.
      phase: canBlock ? "pre" : "post",
      context,
    });

    if (!canBlock) {
      // The call has already run. Findings still travel — a `post` nudge is
      // the whole of what this phase can do, and suppressing it here would
      // leave the phase with no purpose at all.
      return { decision: "allow", reason: null, canBlock, findings };
    }

    // Carried on the allow paths as well as the block, because the two
    // answer different questions. `decision` is about the command;
    // `enforcement` is about whether this session should be running at all,
    // and a displaced session's next call is far more likely to be something
    // ordinary that nothing objects to than something a rule refuses. Only
    // attaching it to a refusal would mean the notice arrived exactly when
    // it was least needed.
    const displaced = enforcement === undefined ? {} : { enforcement };

    const strongest = strongestLevel(findings);
    if (!isBlockingLevel(strongest)) {
      return { decision: "allow", reason: reasonFor(findings), canBlock, findings, ...displaced };
    }

    // Blocked. The reason names only the findings that actually block:
    // including an advisory nudge in a refusal's reason would tell the
    // session to fix something that was not why it was refused, and the
    // first thing it would do is fix the wrong one.
    const blocking = findings.filter((finding) => isBlockingLevel(finding.level));
    return {
      decision: "block",
      reason: reasonFor(blocking),
      canBlock,
      findings,
      ...displaced,
    };
  },
});

/**
 * The one sentence a hook renders, from however many findings there are.
 *
 * `null` for none, because the ordinary allow must stay silent — a reason
 * on every call would put a line of noise into a session after every `Read`
 * it performs.
 *
 * Uses `messages.plain`. The prominent form exists for a surface that can
 * afford to be loud, and a hook's output is prepended to an agent's next
 * turn where every extra line competes with the work; the front end picks
 * the loud one from `findings`, which travels intact.
 */
function reasonFor(findings: readonly InterventionFinding[]): string | null {
  const speaking = findings.filter((finding) => finding.level !== "nothing");
  if (speaking.length === 0) return null;
  return speaking.map((finding) => finding.messages.plain).join(" ");
}

/**
 * Whether any entry for this phase can fire on the context as assembled.
 *
 * ── Why this is gated at all ───────────────────────────────────────────
 *
 * An override changes the level, timing, message or enabled-ness of an
 * entry that *triggers*. A call whose context carries nothing an entry
 * could turn on cannot produce a finding, so its overrides can change
 * nothing — and reading them would be a query on the path that is
 * deliberately query-free for the overwhelming majority of calls.
 *
 * ── Why the gate asks the registry rather than restating it ────────────
 *
 * This used to test `needs` — the function `assembleContext` gates its own
 * *queries* on — plus one hand-named exception for the broad process kill.
 * The reasoning was that reusing `needs` avoids drift. It does the
 * opposite, because **`needs` answers a different question**: it reports
 * which tables to read, not which entries could fire. An entry that decides
 * on facts already in memory needs no table, so `needs` reports nothing for
 * it, and it had to be named here by hand. Exactly one ever was.
 *
 * Three more had accumulated by the time anyone checked, and every one of
 * them silently ignored its stored overrides — a `timing=digest` written
 * for `unscoped-recursive-search` was observed still firing `immediate`:
 *
 *   - `unscoped-recursive-search` — a recursive search's shape;
 *   - `rebase-before-checking-for-conflicts` — a rebase's shape;
 *   - `commit-signing-explicitly-suppressed` — on the verbs other than
 *     `commit`, since `git commit --no-gpg-sign` is masked by
 *     `isWorkRecordingCommand` already asking for the assignment;
 *   - `asking-without-trying-first` — which reads a context flag off the
 *     tool name and involves no command at all, and so could never have
 *     been caught by anything testing command shapes.
 *
 * A hand-maintained list of "entries that need no state" is a list that is
 * updated by remembering, and its failure mode is silent: the entry works,
 * fires, and quietly discards the installation's configuration. So the gate
 * now **asks the entries themselves** — it runs the same predicates
 * `evaluate` is about to run, against the same context, and reads
 * overrides when any of them triggers. That cannot drift from the registry
 * because it *is* the registry, and a new entry of any shape is covered on
 * the day it is added with nothing to remember.
 *
 * ── Why this is affordable on the highest-volume path ──────────────────
 *
 * A predicate is pure and reaches no database: `types.ts` states the rule
 * as *"a predicate declares the context it needs; it does not go and get
 * it"*, and it is structural rather than aspirational — the type a
 * predicate is handed carries data, not a handle. So this pass is arithmetic
 * over strings already in memory, on a context that has already been
 * assembled, and it makes no query by construction. The query it gates
 * remains gated: a `Read`, an `ls` or an `Edit` triggers nothing, so it
 * still reaches no table through this path.
 *
 * The phase is passed through so that only the entries that could run at
 * all are consulted — on a `PostToolUse` the `pre` entries are not asked,
 * matching what `evaluate` will do a few lines later.
 *
 * A wrong "yes" costs one indexed range scan on a call that was already
 * paying for a lookup. A wrong "no" silently ignores an installation's
 * configuration, which is the defect this shape exists to make
 * unrepresentable.
 */
async function couldTrigger(
  context: InterventionContext,
  phase: InterventionPhase,
): Promise<boolean> {
  const findings = await evaluate({ entries: BUILTIN_INTERVENTIONS, phase, context });
  return findings.length > 0;
}

async function readOverridesIfUseful(
  ctx: ServiceContext,
  context: InterventionContext,
  phase: InterventionPhase,
): Promise<Readonly<Record<string, InterventionOverride>>> {
  if (!(await couldTrigger(context, phase))) return {};

  const stored = await readInterventionSettingRows(ctx.db);
  // Nothing stored is the common case and must not cost anything further:
  // an installation that has never configured an entry gets an empty map,
  // and every entry tracks the product exactly as it shipped.
  if (stored.length === 0) return {};

  return resolveInterventionSettings({ stored, entries: BUILTIN_INTERVENTIONS }).overrides;
}
