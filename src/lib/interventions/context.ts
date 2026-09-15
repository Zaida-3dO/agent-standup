// Assembling what a predicate is handed — MILESTONES.md #128.
//
// `InterventionContext` is deliberately a plain value a predicate cannot
// fetch anything through (`./types.ts`). Somebody therefore has to go and
// get it, and this is that somebody: it sits on the service side of the
// boundary, holds the transaction handle, and produces the serialisable
// object the registry passes down.
//
// ── The cost problem, and how it is answered ───────────────────────────
//
// `hook_decision` is declared `kind: "read"` and, until this row, touched
// no table at all — its own header calls a decision made on every tool call
// "the highest-volume path in the system" and says it stays a dumb pipe.
// Consulting the registry threatens exactly that, because the correctness
// entries genuinely need item state, claim state and review artifacts. A
// predicate cannot go and get them, so the assembly would otherwise have to
// fetch them for every call — turning every `Read`, every `ls` and every
// `Edit` into three queries so that the one `git merge` in ten thousand
// calls can be checked.
//
// **So the query is gated on the call being able to need it.** `needs`
// below reads the command text — free, already in memory — and reports
// which *kinds* of state any entry could want for this specific call.
// Nothing needed, no query, and the operation is the dumb pipe it was: that
// is the overwhelmingly common path and it is unchanged in what it costs.
//
// **Why this is not the layering violation it resembles.** The gate decides
// nothing and knows nothing about what any predicate concludes. It is a
// conservative over-approximation: it asks "could a merge check possibly be
// relevant here", errs towards yes, and a wrong yes costs one wasted query
// while a wrong no costs a missed finding. The alternative — letting
// predicates declare their own data dependencies as a schema the assembler
// solves — is the right eventual shape, and is what `INTERVENTIONS.md`'s
// "an intervention declares the context it needs" is reaching for. It needs
// a dependency vocabulary that does not exist yet, and inventing one to
// serve four entries would be fitting a general mechanism to a sample of
// four.
//
// The honest statement of the trade is on the record: this couples the
// assembler to the *shapes* the catalogue cares about, and a new entry
// needing a new kind of state must add a case here. That is a real cost,
// paid deliberately, because the alternative cost — a per-call query budget
// on the highest-volume path in the system — is paid on every call forever
// rather than once per catalogue entry.

import type { TransactionHandle } from "@/lib/service/context";
import { currentTipCommitSha, hasApproval } from "@/lib/service/guards/artifact-tip";
import { hasApprovingArtifactAtCurrentRoundAndTip } from "@/lib/service/guards/merge-review-round";
import { isWriteTool } from "@/lib/telemetry/shape";
import { TERMINAL_STATES } from "@/lib/service/board/columns";
import {
  isMergeAttempt,
  isMergeLanding,
  isPullRequestOpen,
  isWorkRecordingCommand,
} from "./commands";
import { isBroadGitAdd } from "./builtins";
import type { InterventionContext, InterventionPhase } from "./types";
import { normaliseWorktree, sameWorktree } from "./worktree";

/**
 * What the call might need looked up.
 *
 * A record rather than a boolean so that a command needing claim state does
 * not also pay for artifact state. Both are cheap individually; separating
 * them is what keeps them cheap as the catalogue grows.
 */
export interface ContextNeeds {
  /** Which item and claim this session holds — one query over `Assignment`. */
  readonly assignment: boolean;
  /** Whether an approving review sits at the item's tip — the merge gate's own primitives. */
  readonly approval: boolean;
  /** Whether another live crew holds this checkout — I15, one query over `Assignment`. */
  readonly occupancy: boolean;
  /**
   * How much hands-on editing this session has been doing — I14, one
   * windowed query over `ToolCall`.
   *
   * The most expensive thing this assembler can ask for, and the only need
   * that is **not** decided by the command's shape: I14 asks what a session
   * has been doing lately, which no single command can answer. It is gated
   * instead on the *phase* and then, inside `assembleContext`, on the
   * session actually holding its item as an orchestrator — a column the
   * assignment query has already fetched by that point. So the window is
   * read only for orchestrator-held sessions on `post` events, and never on
   * the `PreToolUse` path that decides whether a call may proceed.
   */
  readonly handsOn: boolean;
  /**
   * Whether an earlier agent reported a tool it could not use on this item
   * — I19, one bounded query over `Event`.
   *
   * Gated on the **tool being a spawn**, not on any command shape: the
   * situation is about dispatching, and a dispatch carries no command text
   * to read. That keeps the query off every `Bash` and every read, which is
   * the per-call cost this whole function exists to avoid.
   */
  readonly toolBlocks: boolean;
  /**
   * How far the item's committed work has got, whether several items are
   * waiting on a visual review, and whether a merged nits verdict left
   * findings behind — I25, I26, I27 and I28, on the `post` path only.
   *
   * **Gated on the phase, and then narrowed again inside `assembleContext`.**
   * All four are `post` nudges about work that has stopped moving, so none
   * of them can ever be the reason a `pre` call is allowed or refused, and
   * reading them there would put queries on the path that decides whether a
   * command may run. The second gate is the assignment itself: with no live
   * claim there is no item whose delivery could have stalled, and the
   * assembler returns before any of this is asked.
   *
   * Unlike `handsOn` this is **not** narrowed by tool, and the difference is
   * what each measures. `handsOn` counts a session's own edits, so a `post`
   * event for a read can never carry the count over its threshold and
   * deferring to the next edit costs nothing. These four read facts about
   * the *item* that are equally true whatever call surfaced them — the work
   * is committed and unmerged whether the session just ran `git status` or
   * just edited a file — and gating on writes would silence them for
   * exactly the session that has stopped working, which is the situation
   * they exist to catch.
   */
  readonly delivery: boolean;
}

const NOTHING: ContextNeeds = {
  assignment: false,
  approval: false,
  occupancy: false,
  handsOn: false,
  toolBlocks: false,
  delivery: false,
};

/**
 * Tools whose whole purpose is to modify a file in the checkout.
 *
 * The gate for I15, and deliberately narrower than "write-shaped". These
 * three carry no command text to inspect, so the tool name is the only
 * signal there is that a checkout is being written to — and each of them
 * always is. `Bash` is excluded because it is overwhelmingly reads, and its
 * genuine writes are recognised by shape further down.
 */
const CHECKOUT_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit"]);

function isCheckoutWrite(tool: string | undefined): boolean {
  return tool !== undefined && CHECKOUT_WRITE_TOOLS.has(tool);
}

/**
 * Tools that dispatch a subagent — I19's gate.
 *
 * **The spawn is the one thing about a dispatch this server does observe.**
 * It does not see the tool list the new agent is granted, which is why I19's
 * catalogued detection stays unbuilt; but the hook reports the tool being
 * called, and a spawn tool is a spawn. That is enough for the narrower
 * question this entry actually asks — *is another agent about to be sent at
 * an item whose last agent said it could not do the job?*
 *
 * A set rather than a single literal because the spelling is the client's,
 * not this server's: `Task` is Claude Code's, `Agent` is what several other
 * harnesses call the same call. A name this build does not recognise simply
 * does not gate the query, which is the same no-finding-on-unknown direction
 * every other reading here takes.
 */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

function isSpawn(tool: string | undefined): boolean {
  return tool !== undefined && SPAWN_TOOLS.has(tool);
}

/**
 * Tools that put a question to the person and wait for an answer — I31's
 * gate.
 *
 * Named by the harness rather than by this server, exactly as `SPAWN_TOOLS`
 * is, and for the same reason: a name this build does not recognise simply
 * does not gate anything, which is the no-finding-on-unknown direction
 * every reading here takes. `AskUserQuestion` is Claude Code's;
 * `AskUser` and `ask_user` are what other harnesses call the same call.
 *
 * **This is recognition, not judgement.** Whether a question was worth
 * asking is not knowable from the tool name — that is the whole difficulty
 * of I31 and the reason it is a nudge that fires on every question rather
 * than a guard that tries to pick out the unjustified ones.
 */
const ASK_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "AskUser", "ask_user"]);

function isAsk(tool: string | undefined): boolean {
  return tool !== undefined && ASK_TOOLS.has(tool);
}

/**
 * Tools that constitute hands-on work — I14's tool gate.
 *
 * The shape module's own classification (`isWriteTool`), imported rather
 * than restated so a tool added there is counted here without anyone
 * remembering to. `Bash` is deliberately absent for the same reason it is
 * absent from `CHECKOUT_WRITE_TOOLS`: it is overwhelmingly reads, and
 * putting the window read behind it would gate on nothing.
 */
function isHandsOnTool(tool: string | undefined): boolean {
  return tool !== undefined && isWriteTool(tool);
}

/**
 * Decides what this call could possibly need, from the command text alone.
 *
 * Reads no state, so it cannot itself be the expensive thing. Errs towards
 * needing more: a false positive costs one query on a call that was going
 * to be allowed anyway, and a false negative silently disarms an entry,
 * which is the failure nobody notices.
 *
 * Note what is deliberately absent — a broad process kill (I12) needs no
 * state at all, because the entry blocks on the *shape* of the command and
 * settled explicitly against an ownership check
 * (`docs/plans/INTERVENTIONS.md` I12). So it appears in no branch here, and
 * that is the design rather than an omission.
 */
export function needs(
  command: string | undefined,
  tool?: string,
  phase?: InterventionPhase,
): ContextNeeds {
  // I14 is the one need no command can imply — it asks what the session has
  // been doing lately, not what it is doing now.
  //
  // **Gated on the phase AND the tool, because the phase alone is not a
  // gate.** Roughly half of all hook events are `PostToolUse`, so keying on
  // it by itself would put the assignment query on every `ls`, every
  // `Read` and every `git status` — the per-call cost on the highest-volume
  // path that this whole function exists to avoid. The suite catches it:
  // `hook-decision-operation.test.ts` answers with a handle that throws on
  // any unexpected query, and a phase-only gate fails seven of its cases.
  //
  // The tool half is sound rather than merely cheap. I14's finding is an
  // accumulation of *edits*, so a `post` event for a read can never be the
  // call that carries the count over its threshold — the reading would be
  // identical on the next edit, and deferring it there costs nothing while
  // keeping every read off the query path. A third and narrower gate lives
  // in `assembleContext`, which reads the window only once the assignment
  // row has shown the session holds its item as an orchestrator.
  const handsOn = phase === "post" && isHandsOnTool(tool);
  // I15 turns on no command shape at all — it asks who else holds the
  // checkout — so its gate is the *tool* rather than the command text.
  //
  // **The gate is a file-editing tool, deliberately not every write-shaped
  // one.** `isWriteShaped` (`../hook/nudge.ts`) counts `Bash`, which is the
  // right answer for the question that module asks — has this session
  // changed anything? — and the wrong one here, because `Bash` is also
  // every `ls`, every `git status` and every `npm test`. Gating on it would
  // put a query on the most common call in the system to answer a question
  // only a write can raise, which is precisely the per-call cost this whole
  // function exists to avoid; a test asserts `ls -la` still touches no
  // table, and it would have caught it.
  //
  // A `Bash` command that genuinely writes is not lost: it reaches the same
  // predicate through the command-shape branches below, which is where a
  // command's *meaning* is read. What this gate covers is the tools whose
  // entire purpose is to modify a file in the checkout, where there is no
  // command text to inspect.
  const occupancy = isCheckoutWrite(tool);
  // I19 gates on the spawn tool for the same reason I15 gates on a file
  // edit: a dispatch carries no command text, so the tool name is the only
  // signal there is. It needs the assignment first, in order to know which
  // item's reports to read.
  const toolBlocks = isSpawn(tool);
  // I25/I26/I27/I28 — the flow nudges, on the `post` phase only.
  //
  // **The phase alone is not the gate, for the reason I14 already
  // establishes.** Roughly half of all hook events are `PostToolUse`, so
  // keying on it by itself would put the assignment query behind every
  // `Read`, every `ls` and every `git status` — the per-call cost this
  // whole function exists to avoid, pinned by a case in
  // `hook-decision-operation.test.ts` that a phase-only gate fails.
  //
  // So it is gated on the phase **and** on the call being one that could
  // plausibly have moved the work along: a file edit, or a git command.
  // That is a wider net than I14's — which needs an *edit* specifically,
  // because it is counting edits — and deliberately so: these entries read
  // facts about the item rather than about this session's typing, and a
  // `git push` or a `gh pr create` is exactly the moment the delivery stage
  // has just changed. What it still excludes is the ordinary read traffic
  // that can never be the subject of any of them — `git status`, `ls`,
  // `npm test` and every `Read` stay free, which the zero-query suite pins.
  //
  // `isWorkRecordingCommand` is reused rather than restated: it already
  // recognises exactly `git commit` and `git push` and already excludes
  // `--amend` and `--dry-run`, which is the same "work has just moved"
  // question asked for I13. `isPullRequestOpen` adds the one shape it has
  // no reason to know about.
  //
  // **`isMergeLanding` adds the closing moment, which is what I28 is
  // actually about.** Without it the gate covered the commit/push boundary
  // and stopped short of the merge: I28
  // (`nits-merged-with-nothing-tracking-them`) fired while a row was still
  // being worked and went silent at `gh pr merge`, the exact event where
  // outstanding findings stop being visible. Its own docstring picks
  // `immediate` timing because it "describes a row that is CLOSING", so a
  // gate that excluded the close was one clause short of its own entry.
  //
  // **It is deliberately NOT `isMergeAttempt`, and the difference is
  // `git pull`.** `isMergeAttempt` also matches a bare `git pull`, which
  // is correct for the `approval` limb below — a pull can write a merge
  // commit out of divergent history, and that is unreviewed work. But a
  // pull is the opposite of a close: it catches a branch *up*, at the start
  // or the middle of work, so no finding can become invisible because of
  // one and it can never be the subject of any of these entries. Reusing
  // `isMergeAttempt` here would therefore buy zero extra findings while
  // putting the assignment and artifact lookups behind the single
  // highest-frequency git command a session runs — the precise cost this
  // gate exists to avoid, and the reason `git pull` is named in the
  // zero-query cases rather than left to be inferred.
  const delivery =
    phase === "post" &&
    (isHandsOnTool(tool) ||
      (command !== undefined &&
        (isWorkRecordingCommand(command) ||
          isPullRequestOpen(command) ||
          isMergeLanding(command))));

  if (command === undefined || command.trim() === "") {
    return occupancy || handsOn || toolBlocks || delivery
      ? { assignment: true, approval: false, occupancy, handsOn, toolBlocks, delivery }
      : NOTHING;
  }

  // A merge attempt is the only shape that needs to know whether an
  // approval sits at the tip, and it needs the assignment first in order to
  // know *which item's* tip to ask about.
  if (isMergeAttempt(command))
    return { assignment: true, approval: true, occupancy, handsOn, toolBlocks, delivery };

  // A broad `git add` needs to know whether the checkout is shared, which
  // is the claim's `worktree` — no artifact question is involved.
  if (isBroadGitAdd(command))
    return { assignment: true, approval: false, occupancy, handsOn, toolBlocks, delivery };

  // I13 needs only to know whether this session holds a claim at all, which
  // the assignment lookup answers on its own — no artifact question and no
  // occupancy question are involved.
  if (isWorkRecordingCommand(command))
    return { assignment: true, approval: false, occupancy, handsOn, toolBlocks, delivery };

  return occupancy || handsOn || toolBlocks || delivery
    ? { assignment: true, approval: false, occupancy, handsOn, toolBlocks, delivery }
    : NOTHING;
}

/** The one row shape the claim lookup reads. */
interface AssignmentRow {
  itemId: string;
  worktree: string | null;
  state: string;
  defaultBranch: string | null;
  /** The root of this session's own crew — compared against, never displayed. */
  rootSessionId: string;
  /** The repository the claimed item belongs to. Null when the item names none. */
  repo: string | null;
  /** The role the claim was taken in — I14's first and cheapest gate. */
  role: string;
  /**
   * The machine the claim was taken on.
   *
   * Read off the assignment, which is the row that owns it: `claim` requires
   * a machine and stores it here, and it does so without a `Session` row
   * existing at all — session registration is a separate act that an
   * installation is not obliged to perform. A lookup that resolved the
   * machine through `Session` would therefore answer `null` for the ordinary
   * claim and silently disable every check keyed on it.
   */
  machine: string;
}

/** One other crew holding the same checkout — I15's query result. */
interface OccupancyRow {
  rootSessionId: string;
  itemId: string;
  branch: string | null;
  worktree: string | null;
  lastActiveSecondsAgo: number | null;
}

/**
 * How long a holder may be quiet before I15 stops deferring to it.
 *
 * Twelve hours. The bound exists because `liveness` cannot carry this on its
 * own: `sweepLiveness` has no caller (MILESTONES.md #99) and the claim insert
 * is `ON CONFLICT DO NOTHING`, so a crashed session's row stays `running`
 * indefinitely and every future crew in that repository is refused on behalf
 * of a crew that stopped days ago. Three separate crews hit exactly that on
 * 2026-08-31, all deferred to one holder ~10.9 days quiet.
 *
 * Twelve hours rather than something tighter because the cost of the two
 * errors is not symmetric. Too short and a genuine collision goes unblocked
 * while its holder is merely thinking — a long test run, a slow review, a
 * session waiting on a person — which is the incident this entry exists to
 * prevent. Too long and a stale row blocks a live crew, which is annoying,
 * visible immediately, and self-correcting once the sweep exists. So the
 * bound is set well past any plausible pause within a working session and
 * well inside the multi-day staleness that was actually observed, and it is
 * deliberately not tuned finer than that: a threshold chosen to the minute
 * would be a number nobody could justify.
 *
 * It applies on top of `liveness = 'running'` and both must hold: a holder
 * marked stalled or dead is ignored however recently it spoke, and a holder
 * still marked running is ignored once it passes this bound.
 */
const HOLDER_STALE_AFTER_SECONDS = 12 * 60 * 60;

/**
 * How many candidate holders the occupancy query reads.
 *
 * The worktree comparison happens in this process rather than in SQL (see
 * `occupancyFor`), so the query returns a set of candidates rather than a
 * single row — the freshest claim in the repository is often a sibling
 * worktree, and stopping at it would miss the crew sharing this tree.
 *
 * A bound rather than an unbounded read because this is the highest-volume
 * path in the system: one machine running many claims in one repository
 * would otherwise read all of them on every file edit. Sixteen concurrent
 * worktrees of one repository is an observed real number here, so the bound
 * is set well above it while still being a bound.
 */
const CANDIDATE_LIMIT = 50;

/**
 * How many of a crew's live assignments the width query reads.
 *
 * A bound rather than an unbounded read, like every other query here. The
 * previous form was a `COUNT`, which needed none; reading rows to answer the
 * worktree question needs one. Set well above any crew width this system
 * encourages — the entry that consumes it already calls three "wide" — so it
 * can only be reached by a root session holding far more than anyone would
 * dispatch deliberately, and at that width the finding is the same whether
 * the tail is read or not.
 */
const CREW_ROW_LIMIT = 200;

/**
 * Builds the context for one hook event.
 *
 * Every field it cannot honestly answer is left **absent**, never
 * defaulted. That is the contract the predicates are written against: an
 * absent field means "not known", and `./builtins.ts` treats not-known as
 * no-finding rather than as licence to guess. A `false` written here where
 * the truth is unknown would silently convert such an entry from cautious
 * to confidently wrong — and for the blocking entries, that is the
 * difference between a guard and an obstacle.
 */
export async function assembleContext(options: {
  readonly db: TransactionHandle;
  readonly sessionId: string;
  readonly tool?: string;
  readonly command?: string;
  /**
   * Which side of the call this is. Absent behaves as `pre`, which is the
   * cautious reading: the `post`-only window read stays unmade rather than
   * being made speculatively for a caller that did not say.
   */
  readonly phase?: InterventionPhase;
  /** I14's thresholds. Handed in, like every other threshold in this system. */
  readonly handsOn?: HandsOnThresholds;
  /**
   * `liveness.dead_after_seconds`, for the crew-in-flight count.
   *
   * Handed in rather than defaulted, like every other threshold here. A
   * default would be a second copy of a configured value, and the point of
   * reusing the Fleet page's notion of liveness is that there is exactly one
   * threshold — a caller that does not supply it gets the field left absent,
   * which every predicate already reads as "not known".
   */
  readonly crewInFlightDeadAfterSeconds?: number;
}): Promise<InterventionContext> {
  const { db, sessionId, tool, command, phase, handsOn, crewInFlightDeadAfterSeconds } = options;

  const base: InterventionContext = {
    sessionId,
    ...(tool === undefined ? {} : { tool }),
    ...(command === undefined ? {} : { command }),
    // I31 — read off the tool name, so it is on the base context rather
    // than behind the assignment gate. A session that stops to ask a
    // question very often holds no claim, and gating this on one would
    // silence the entry for exactly the callers it is addressed to. It
    // costs no query, which is what makes that affordable.
    ...(isAsk(tool) ? { isAskingUser: true } : {}),
  };

  const wanted = needs(command, tool, phase);
  if (!wanted.assignment) return base;

  // The session's live claim, and the item and repository behind it. One
  // query rather than three: an item's state and its repository's default
  // branch are both facts about the same claim, and asking for them
  // separately would let two of them describe different claims.
  const rows = await db.$queryRawUnsafe<AssignmentRow[]>(
    `SELECT a."itemId"          AS "itemId",
            a."worktree"        AS "worktree",
            a."rootSessionId"   AS "rootSessionId",
            i."state"::text     AS "state",
            i."repo"            AS "repo",
            a."role"::text      AS "role",
            r."defaultBranch"   AS "defaultBranch",
            a."machine"         AS "machine"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
       LEFT JOIN "Repo" r ON r."id" = i."repo"
      WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL
      ORDER BY a."claimedAt" DESC
      LIMIT 1`,
    sessionId,
  );

  const claim = rows[0];
  // No live claim is a genuine and common state — an unclaimed session
  // running commands — and it is not an error. It leaves every item-shaped
  // field absent, which is exactly right: there is no item to say anything
  // about.
  //
  // **`holdsClaim` is the exception, and it is I13's whole signal.** The
  // lookup ran and came back empty, so "this session holds nothing" is a
  // fact established rather than a question skipped — which is precisely
  // the distinction `itemId`'s absence cannot carry, because that is also
  // what a call the gate never looked up looks like.
  if (claim === undefined) return { ...base, holdsClaim: false };

  const withClaim: InterventionContext = {
    ...base,
    holdsClaim: true,
    claimedRole: claim.role,
    itemId: claim.itemId,
    itemState: claim.state,
    // A claim records the worktree it was taken in. A non-empty value means
    // a linked worktree with its own index; `null` means the claim never
    // recorded one, which is **unknown**, not "the shared checkout" — so
    // the field stays absent rather than becoming `false`.
    //
    // **This answers I11's question, not I15's**, and conflating the two is
    // what made I15 fire on the healthy case. I11 asks whether the caller's
    // *own* index is shared, which its own path genuinely settles — a linked
    // worktree has its own index whoever else is around. I15 asks whether
    // the caller and the *holder* are in one tree, which no fact about the
    // caller alone can answer, and which is now settled by comparing the two
    // paths in `occupancyFor` below.
    ...(claim.worktree === null ? {} : { isLinkedWorktree: claim.worktree.trim() !== "" }),
    // Carried for the refusal message, so a caller can see which path was
    // matched against theirs. Raw, deliberately — see the field's own note.
    ...(claim.worktree !== null && normaliseWorktree(claim.worktree) !== undefined
      ? { claimedWorktree: claim.worktree }
      : {}),
  };

  // I15 — who else holds this checkout. Keyed on `(machine, repo)` and
  // compared on ROOT sessions, for the reasons the entry itself records:
  // `worktree` is unnormalised free text that does not compare equal across
  // spellings, and a worker its own orchestrator spawned shares the
  // checkout legitimately.
  const withOccupancy = wanted.occupancy
    ? { ...withClaim, ...(await occupancyFor(db, claim)) }
    : withClaim;

  // I14 — how much of the work this session has been doing itself.
  //
  // **The role test is the gate, and it is why this query is affordable.**
  // `wanted.handsOn` only established that the phase could ask; this is
  // where the question is actually narrowed, against a column the
  // assignment query above has already fetched. A builder, a reviewer, a
  // scout and an unclaimed session all skip the window entirely, so the
  // read lands only on sessions holding an item as an orchestrator — a
  // small minority of claims and a smaller minority of calls.
  const withHandsOn =
    wanted.handsOn && claim.role === "orchestrator"
      ? { ...withOccupancy, handsOnWork: await handsOnWorkFor(db, sessionId, handsOn) }
      : withOccupancy;

  // I19 — tool blocks an earlier agent on this item reported and nothing
  // has cleared. Gated on the spawn tool above, so this runs only on a
  // dispatch, never on the ordinary call path.
  const withToolBlocks = wanted.toolBlocks
    ? {
        ...withHandsOn,
        ...(await toolBlocksFor(db, claim.itemId)),
        // I29 — how wide this crew already is. Shares I19's gate exactly:
        // both questions are only worth asking on a dispatch, and both are
        // answered against the same claim, so the spawn gate that already
        // earns its keep for one covers the other at one extra query on a
        // path that runs only when an agent is actually being spawned.
        ...(await crewWidthFor(db, claim)),
      }
    : withHandsOn;

  // I25/I26/I27/I28 — where the work has got to, and what it left behind.
  // Gated on the `post` phase and a delivery-shaped call above, so this
  // never runs on the path that decides whether a command may proceed.
  const withDelivery = wanted.delivery
    ? {
        ...withToolBlocks,
        ...(await deliveryFor(db, claim.itemId)),
        ...(await untrackedNitsFor(db, claim.itemId)),
        ...(await pendingVisualReviewsFor(db)),
        // I30 — a visual review this item needed, deferred to nowhere.
        // Rides the same delivery gate as I25/I26/I27/I28: it is a fact
        // about where the item got to, asked on the `post` path only.
        ...(await deferredVisualReviewFor(db, claim.itemId)),
      }
    : withToolBlocks;

  // Crew still running under this session's root.
  //
  // **Gated exactly as I14's window is: the delivery gate, then the
  // orchestrator role.** The second gate is what makes it affordable, and
  // it is also what makes it meaningful — `rootSessionId` on a builder's
  // claim points at the orchestrator above it, so asking this for a builder
  // would count its *siblings* and report them as the builder's own crew.
  // Only the session that is the root of its crew gets a true answer, and a
  // number that is true for one caller and misleading for another is worse
  // than one that is simply absent for the second.
  //
  // `crewInFlightDeadAfterSeconds` absent means the caller did not supply
  // the threshold, and there is no default here on purpose: a defaulted
  // threshold would be a fourth definition of liveness invented at the call
  // site, which is the exact drift this reuses the Fleet notion to avoid.
  const withCrew =
    wanted.delivery && claim.role === "orchestrator" && crewInFlightDeadAfterSeconds !== undefined
      ? {
          ...withDelivery,
          ...(await crewInFlightFor(db, claim, sessionId, crewInFlightDeadAfterSeconds)),
        }
      : withDelivery;

  if (!wanted.approval) return withCrew;

  // The merge gate's own primitives, reused rather than reimplemented. If
  // this asked the question differently from the guard that enforces it at
  // `transition_item`, the two would eventually disagree — and the version
  // that disagreed would be the one blocking a session's shell command with
  // no way to see why.
  const tip = await currentTipCommitSha(db, claim.itemId);
  const approved = await hasApprovingArtifactAtCurrentRoundAndTip(db, claim.itemId, "code_review");
  // The second approval question, and the one that separates a merge nobody
  // reviewed from a merge whose review was demoted by later bookkeeping.
  //
  // **Only asked when the first one said no.** An approval standing at the
  // tip already answers "has this ever been approved" — reading the wider
  // question anyway would put a second artifact query on every approved
  // merge to compute a value no entry can act on, since both entries below
  // require `hasApprovalAtTip === false` before they look at this at all.
  const everApproved =
    tip !== null && !approved ? await hasApproval(db, claim.itemId, "code_review") : undefined;

  return {
    // **`withDelivery`, not `withHandsOn`.** This spread was written when
    // the approval branch was the last one added and `withHandsOn` was the
    // newest accumulator; every field gathered after it — I19's tool blocks,
    // and now the delivery fields — was silently discarded on any call that
    // also needed the approval lookup. It never showed in behaviour because
    // the overlap is narrow (a merge attempt that is also a spawn, or a
    // `git push` on the `post` phase) and the loss is an entry going quiet
    // rather than misfiring, which is the failure mode nobody notices.
    // Spreading the last accumulator is what makes adding the next branch
    // safe, so this is the shape to keep rather than a one-off correction.
    ...withDelivery,
    // With no commit artifact at all there is no tip for an approval to be
    // at, so "is there an approval at tip" has no true answer and the field
    // stays absent. An item nobody has committed to is not an item somebody
    // is merging without review; it is one that has not got there yet.
    ...(tip === null ? {} : { hasApprovalAtTip: approved }),
    ...(everApproved === undefined ? {} : { hasAnyApproval: everApproved }),
    ...(claim.defaultBranch === null ? {} : { defaultBranch: claim.defaultBranch }),
  };
}

/**
 * How many reported tool blocks are read on one dispatch.
 *
 * A bound rather than an unbounded read, like every other query here. An
 * item with more than a handful of distinct unusable tools has a briefing
 * problem no message can enumerate its way out of, so reading further would
 * cost queries to produce a nudge nobody finishes.
 */
const TOOL_BLOCK_LIMIT = 5;

/** One `report_blocked_on_tool` escalation, as the query returns it. */
interface ToolBlockRow {
  tool: string | null;
  reason: string | null;
  needed: string | null;
}

/**
 * The tool blocks reported on this item that nothing has since cleared.
 *
 * ── What counts as cleared, and why it is this ─────────────────────────
 *
 * **A claim taken after the report.** The orchestrator's response to "I
 * could not use this tool" is to fix the provisioning and dispatch again,
 * and the new agent's `claim` is the first server-visible act of that
 * dispatch. So a report older than the newest claim on the item has already
 * been answered — by an agent that either did not need the tool or was
 * given it — and saying so again would nag about settled history.
 *
 * The honest limit of that reading: an orchestrator that dispatches again
 * **without** fixing anything also produces a claim, so the second crew
 * clears the first crew's report. That is the correct trade rather than a
 * flaw to work around. The alternative — treating a report as unresolved
 * forever — fires on every subsequent dispatch for the life of the item,
 * including the ones that did fix it, and an entry that cannot be satisfied
 * is exactly the kind that earns a 1 and gets switched off. The second crew
 * hitting the same wall files its own report, which is newer than that
 * claim and fires again.
 *
 * `reason` and `needed` are read from the payload and the body the
 * operation wrote, so the message can name the tool and the remedy rather
 * than reminding in the abstract — which the catalogue explicitly asks for.
 */
async function toolBlocksFor(
  db: TransactionHandle,
  itemId: string,
): Promise<Pick<InterventionContext, "unresolvedToolBlocks">> {
  const rows = await db.$queryRawUnsafe<ToolBlockRow[]>(
    `SELECT e."payload"->>'blocked_on_tool' AS "tool",
            e."payload"->>'reason'          AS "reason",
            e."body"                        AS "needed"
       FROM "Event" e
      WHERE e."itemId" = $1
        AND e."type" = 'escalation'
        AND e."payload" ? 'blocked_on_tool'
        AND e."ts" > COALESCE(
              (SELECT MAX(a."claimedAt") FROM "Assignment" a WHERE a."itemId" = $1),
              '-infinity'::timestamptz)
      ORDER BY e."ts" DESC
      LIMIT $2`,
    itemId,
    TOOL_BLOCK_LIMIT,
  );

  // A row whose tool is missing is not a finding — the field is the whole
  // point of the entry, and a nudge that cannot name the tool is the
  // "generic reminder" the catalogue calls weak medicine.
  const blocks = rows.flatMap((row) =>
    row.tool === null
      ? []
      : [
          {
            tool: row.tool,
            reason: row.reason ?? "unknown",
            ...(row.needed === null ? {} : { needed: row.needed }),
          },
        ],
  );

  // Absent rather than empty, like every other optional field here: the
  // predicate reads "did not look" and "looked and found none" the same way,
  // so there is nothing an empty array would say that absence does not.
  return blocks.length === 0 ? {} : { unresolvedToolBlocks: blocks };
}

/**
 * The thresholds I14's reading is taken against.
 *
 * Handed in rather than read from a settings resolver here, for the same
 * reason `ShapeThresholds` is (`../telemetry/shape.ts`): this module is on
 * the service side and the caller already holds the resolver, and passing
 * them makes every threshold visible at the call site of a test rather than
 * mocked behind one.
 */
export interface HandsOnThresholds {
  /** Fewer calls than this in the window and the answer is `unknown`. */
  readonly minimumSample: number;
  /** Edits at or above this, within the window, read as elevated. */
  readonly editThreshold: number;
  /** How many recent calls the reading is taken over. */
  readonly window: number;
}

/**
 * How much hands-on editing a session has been doing lately — I14.
 *
 * ── Why this counts edits rather than reusing `readSessionShape` ───────
 *
 * `../telemetry/shape.ts` is reused for what it actually measures — the
 * `isWriteTool` classification is imported rather than restated, so a tool
 * added there is counted here without anyone remembering to. What is not
 * reused is `readShare`, and the reason is that it answers a different
 * question: it reports the *proportion* of a session that is reading, and
 * I14 is about an absolute amount of editing.
 *
 * The distinction decides real cases. An orchestrator that reads forty
 * files to brief a crew and edits three has a low read share by nobody's
 * definition of a problem — it is doing its job well. An orchestrator that
 * makes twenty edits and no reads has a read share of zero and is exactly
 * the drift this entry exists to catch. Keyed on the proportion, the first
 * fires and the second may not; keyed on the count, both come out right.
 *
 * ── `unknown` is a real answer ─────────────────────────────────────────
 *
 * Below the minimum sample this returns `"unknown"`, which the predicate
 * treats as no finding. That is deliberate and it is the same reading the
 * shape module uses: a session a few calls old has established nothing, and
 * a guard that fired there would nudge every orchestrator on its opening
 * moves — which is how a digest teaches its reader to skip it.
 */
async function handsOnWorkFor(
  db: TransactionHandle,
  sessionId: string,
  thresholds: HandsOnThresholds | undefined,
): Promise<"unknown" | "normal" | "elevated"> {
  // No thresholds means the caller did not configure this reading, and a
  // count compared against a number nobody chose is not a finding. Answered
  // `unknown` rather than defaulted, because inventing a threshold here is
  // exactly the "silently wrong" shape the catalogue keeps retreating from.
  if (thresholds === undefined) return "unknown";

  const rows = await db.$queryRawUnsafe<{ tool: string }[]>(
    `SELECT "tool"
       FROM "ToolCall"
      WHERE "sessionId" = $1
      ORDER BY "ts" DESC, "id" DESC
      LIMIT $2`,
    sessionId,
    thresholds.window,
  );

  if (rows.length < thresholds.minimumSample) return "unknown";

  const edits = rows.filter((row) => isWriteTool(row.tool)).length;
  return edits >= thresholds.editThreshold ? "elevated" : "normal";
}

/**
 * Finds another live crew holding the same checkout, if there is one.
 *
 * Returns a fragment to spread rather than a value, so "nobody else is
 * here" and "the question could not be asked" produce the same thing — an
 * absent field — without the caller branching on which it was. The
 * predicate reads both as no finding, which is the honest answer to both.
 *
 * ── The three conditions, each load-bearing ────────────────────────────
 *
 *   - The `(machine, repo)` pair must be answerable. The machine is read off
 *     the assignment rather than resolved through a session, because `claim`
 *     stores it there and does not require a session registration to exist —
 *     resolving it the other way answers `null` for an ordinary claim and
 *     silently disables the entry. The item's repository is genuinely
 *     nullable, and without it the pair cannot be compared.
 *   - `rootSessionId <> $3` is the self-exclusion. Compared on roots, so an
 *     orchestrator and the builder it spawned do not block each other —
 *     this is the distinction `registered_processes` established and I15 is
 *     its first consumer.
 *   - `liveness = 'running'` and `releasedAt IS NULL`. A stalled or dead
 *     crew is the liveness sweep's business, not this entry's: blocking on
 *     a claim whose holder is gone would refuse work on the strength of a
 *     crew that has already finished.
 *   - **`lastActive` within `HOLDER_STALE_AFTER_SECONDS`.** The liveness
 *     column alone cannot carry this, because nothing moves it off
 *     `running` — see that constant for the incident.
 *
 * ── Same machine and repository is the prefilter, not the answer ───────
 *
 * `(machine, repo)` narrows the candidates to claims that *could* share a
 * working tree, and then the worktree paths decide whether they actually
 * do. Both halves are needed and neither is sufficient: the pair alone
 * cannot tell one shared directory from sixteen sibling worktrees of one
 * repository, which is the arrangement every parallel dispatch here uses
 * and which this entry was refusing on every file edit.
 *
 * The comparison is done in TypeScript over `normaliseWorktree` rather than
 * in SQL, and that is deliberate. The folding it needs — slash direction,
 * drive-letter case on Windows paths but not on POSIX ones, `..` arithmetic
 * — is a page of reasoning that belongs somewhere testable on its own; as a
 * `WHERE` clause it would be an unreadable expression that only the database
 * job could exercise. So the query keeps the cheap, indexable half of the
 * predicate and the process keeps the half that needs judgement.
 *
 * **Candidates are therefore fetched rather than a single row**, bounded by
 * `CANDIDATE_LIMIT`. The bound matters more than it looks: without it, one
 * machine with many claims in one repository would read every one of them
 * on every file edit.
 *
 * ── When a path is missing, nobody is blocked ──────────────────────────
 *
 * If either side recorded no worktree, `sameWorktree` answers `undefined`
 * and that candidate is **skipped**. This is the single most consequential
 * line in the change, so the reasoning is stated rather than implied.
 *
 * `Assignment.worktree` is nullable and `claim`'s `worktree` is optional,
 * so an unknown path is the *common* case rather than an edge one — most
 * claims in the wild carry nothing. Reading unknown as "same tree" would
 * therefore restore precisely the behaviour being fixed, and would do it
 * for the majority of claims: every crew whose claim omitted an optional
 * field, blocked on a question that was never asked.
 *
 * The cost is honest and worth naming: two crews genuinely sharing one
 * checkout, neither of which recorded a path, are **not** caught. The entry
 * is a `block-overridable` on the highest-volume path in the system, and
 * the catalogue's consistent reading of an unanswerable question is no
 * finding — the same reading `broad-git-add-on-shared-checkout` takes two
 * hundred lines up, and the same one this function already takes when the
 * repository is null. What closes that gap is claims recording their
 * worktree, not this predicate guessing.
 */
async function occupancyFor(
  db: TransactionHandle,
  claim: AssignmentRow,
): Promise<Partial<InterventionContext>> {
  // Only the repository can be unknown here. `Assignment.machine` is NOT
  // NULL and `claim` requires it, so the machine half of the pair is always
  // answerable; the item's `repo` is nullable, and without it the pair
  // cannot be compared — a query that dropped that half would match every
  // checkout on the machine against this one.
  if (claim.repo === null) return {};

  // Nothing to compare against. Established before the query rather than
  // after it, so the common unclaimed-path case costs no read at all.
  if (normaliseWorktree(claim.worktree) === undefined) return {};

  const rows = await db.$queryRawUnsafe<OccupancyRow[]>(
    `SELECT a."rootSessionId" AS "rootSessionId",
            a."itemId"        AS "itemId",
            a."branch"        AS "branch",
            a."worktree"      AS "worktree",
            FLOOR(EXTRACT(EPOCH FROM (NOW() - a."lastActive")))::int AS "lastActiveSecondsAgo"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
      WHERE a."machine" = $1
        AND i."repo" = $2
        AND a."rootSessionId" <> $3
        AND a."releasedAt" IS NULL
        AND a."liveness" = 'running'
        AND a."worktree" IS NOT NULL
        AND a."lastActive" > NOW() - MAKE_INTERVAL(secs => $4)
      ORDER BY a."lastActive" DESC
      LIMIT $5`,
    claim.machine,
    claim.repo,
    claim.rootSessionId,
    HOLDER_STALE_AFTER_SECONDS,
    CANDIDATE_LIMIT,
  );

  // The most recently active candidate that is genuinely in this working
  // tree. Ordered by `lastActive DESC` in the query, so the first match is
  // the freshest holder — a caller pointed at the stalest one would be sent
  // to whoever is least likely to still be there.
  const holder = rows.find((row) => sameWorktree(claim.worktree, row.worktree) === true);
  if (holder === undefined) return {};

  return {
    occupyingCrew: {
      rootSessionId: holder.rootSessionId,
      itemId: holder.itemId,
      ...(holder.branch === null ? {} : { branch: holder.branch }),
      ...(holder.lastActiveSecondsAgo === null
        ? {}
        : { lastActiveSecondsAgo: holder.lastActiveSecondsAgo }),
    },
  };
}

/**
 * How many crew under one root are genuinely running right now.
 *
 * ── The liveness test is the Fleet page's, deliberately ────────────────
 *
 * `Assignment.liveness` is a **stored** column that only the sweep advances
 * (`../liveness.ts`), so on its own it reports the last pass's verdict
 * rather than the current state. Grouping on it directly is precisely the
 * defect #400 fixed on the Fleet page, where "Running (27)" counted claims
 * whose holders had been gone for days.
 *
 * So this asks the same two-part question `bandOf` now asks
 * (`../fleet/view.ts`): the row must still say `running` **and** its
 * `lastActive` must be newer than the dead threshold. Expressed in SQL here
 * rather than by importing `isOverdueForSweep`, because that function reads
 * a `FleetAssignment` view-model this path never builds — but it is the same
 * predicate, and the deliberate choice is to have one notion of liveness in
 * two dialects rather than two notions. `deadAfterSeconds` is handed in from
 * the same `liveness.dead_after_seconds` setting the Fleet page reads, so
 * they cannot drift on the threshold either.
 *
 * ── Why the session excludes itself ────────────────────────────────────
 *
 * The asking session is running by definition — it is making this very call.
 * Counting it would put a floor of one under the number, which would make
 * zero unreachable and "nobody is running" inexpressible. That is the whole
 * signal, so the exclusion is load-bearing rather than tidiness.
 *
 * ── Why `{}` rather than `0` when the query answers nothing ────────────
 *
 * `COUNT` always returns a row, so an empty result set means the query did
 * not answer rather than that the count was zero — the same reading every
 * other optional field here takes. Writing `0` there would convert "I could
 * not tell" into "you are free to stop", which is the inversion the type's
 * header warns about and the one this row exists to avoid.
 */
async function crewInFlightFor(
  db: TransactionHandle,
  claim: AssignmentRow,
  sessionId: string,
  deadAfterSeconds: number,
): Promise<Pick<InterventionContext, "crewInFlight">> {
  const rows = await db.$queryRawUnsafe<{ crew: number }[]>(
    `SELECT COUNT(DISTINCT a."sessionId")::int AS "crew"
       FROM "Assignment" a
      WHERE a."rootSessionId" = $1
        AND a."sessionId" <> $2
        AND a."releasedAt" IS NULL
        AND a."liveness" = 'running'
        AND a."lastActive" > NOW() - MAKE_INTERVAL(secs => $3)`,
    claim.rootSessionId,
    sessionId,
    deadAfterSeconds,
  );

  const row = rows[0];
  if (row === undefined) return {};
  return { crewInFlight: row.crew };
}

/**
 * How far this item's committed work has got toward being merged — I26/I27.
 *
 * **One query over `Artifact` and `Event` rather than three.** The stages
 * are mutually exclusive and derived from the same two facts, so asking
 * separately would let two of them describe different moments: a pull
 * request opened between a "has it committed" read and a "has it a pull
 * request" read would report the impossible pair.
 *
 * ── What "no commit artifact" means, and why it is absent rather than a
 * stage ────────────────────────────────────────────────────────────────
 *
 * An item nobody has committed to has not stalled on its way to a pull
 * request — it has not started, and it is usually mid-build. Reporting a
 * stage there would fire I26 on every item from the moment it was claimed
 * until its first commit, which is most of an item's working life and
 * exactly the "fires on the ordinary case" failure that teaches a reader to
 * skip the digest. So the field stays absent, like every other unknown
 * here, and both entries decline.
 *
 * ── Why `review_requested` is a stage rather than simply absent ────────
 *
 * It carries no finding of its own; it exists so that I27 has something to
 * be silent *about*. Without it, "a review has been requested" and "this
 * item has no pull request" would both have to be spelled as the absence of
 * the `pull_request_open` stage, and a later entry keyed on that absence
 * would be unable to tell them apart.
 */
async function deliveryFor(
  db: TransactionHandle,
  itemId: string,
): Promise<Pick<InterventionContext, "deliveryStage" | "pullRequestAgeSeconds">> {
  const rows = await db.$queryRawUnsafe<
    {
      hasCommit: boolean;
      hasPullRequest: boolean;
      hasReviewRequest: boolean;
      pullRequestAgeSeconds: number | null;
    }[]
  >(
    `SELECT EXISTS (SELECT 1 FROM "Artifact" WHERE "itemId" = $1 AND "kind" = 'commit')
              AS "hasCommit",
            EXISTS (SELECT 1 FROM "Artifact" WHERE "itemId" = $1 AND "kind" = 'pull_request')
              AS "hasPullRequest",
            EXISTS (SELECT 1 FROM "Event" WHERE "itemId" = $1 AND "type" = 'review_requested')
              AS "hasReviewRequest",
            (SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(a."createdAt"))))::int
               FROM "Artifact" a
              WHERE a."itemId" = $1 AND a."kind" = 'pull_request')
              AS "pullRequestAgeSeconds"`,
    itemId,
  );

  const row = rows[0];
  if (row === undefined) return {};
  // A review already requested settles it whatever else is true: from here
  // the existing flow entries take over, and neither I26 nor I27 has
  // anything left to say.
  if (row.hasReviewRequest) return { deliveryStage: "review_requested" };
  if (row.hasPullRequest)
    return {
      deliveryStage: "pull_request_open",
      // ── The grace window's input, per the owner's "shortly after" ──────
      //
      // **The NEWEST pull-request artifact, not the oldest.** An item that
      // reopened or replaced its pull request has started its flow again,
      // and measuring from the first one would treat a minute-old pull
      // request as hours stale because an earlier one existed. `MAX` is what
      // makes the age describe the artifact that is actually waiting.
      //
      // Absent stays absent: a null age means no artifact carried a
      // timestamp, which the predicate must read as "cannot tell" rather
      // than as old enough to speak.
      ...(row.pullRequestAgeSeconds === null
        ? {}
        : { pullRequestAgeSeconds: row.pullRequestAgeSeconds }),
    };
  if (row.hasCommit) return { deliveryStage: "committed" };
  return {};
}

/**
 * A `lgtm_with_nits` review whose findings nothing is tracking — I28.
 *
 * ── Why the *latest* review rather than any review ─────────────────────
 *
 * Keyed on the newest review artifact carrying a verdict, because a verdict
 * is superseded by the next round rather than accumulated: an item whose
 * round-1 review said `lgtm_with_nits` and whose round-2 review said
 * `changes_required` is not sitting on untracked nits, it is being reworked.
 * Reading every review instead would fire on the settled history of any
 * item that ever received the verdict, for the rest of its life.
 *
 * ── What counts as tracked ─────────────────────────────────────────────
 *
 * `followUpItemId` being set on that artifact — the same column
 * `lgtm_with_followups` already uses for exactly this relationship, reused
 * rather than given a parallel mechanism. A reviewer that minted a row and
 * linked it has done the thing this entry asks for, and must not then be
 * nudged about it.
 *
 * **Not** counted as tracked: the nits having been fixed in the change
 * itself. Nothing records that, and the entry says so — its message accepts
 * "actioned here" as an answer rather than demanding a row, because the
 * alternative trains callers to mint bookkeeping items for work already
 * done. That is the accepted false positive, and it is named in the entry.
 *
 * ── Why `jsonb_array_length` and why the guard around it ───────────────
 *
 * `findings` is a jsonb document, and a nits verdict that recorded no
 * findings has nothing to lose — so the count is the signal rather than the
 * verdict alone. The type check is not defensive padding: the column is
 * nullable and historical rows may hold a non-array document, and
 * `jsonb_array_length` raises on one rather than returning null, which
 * would turn a malformed old artifact into a failed hook call.
 */
async function untrackedNitsFor(
  db: TransactionHandle,
  itemId: string,
): Promise<Pick<InterventionContext, "untrackedNits">> {
  // ── Why the verdict is tested OUTSIDE the row selection ───────────────
  //
  // The inner query picks the **governing** review — the latest one
  // carrying a verdict — and the outer conditions then ask whether *that*
  // row is the situation. Pushing `verdict = 'lgtm_with_nits'` into the
  // inner `WHERE` reads as equivalent and is not: it would skip *past* a
  // newer `changes_required` to find an older nits verdict underneath, and
  // fire on an item that is being reworked. A superseded verdict is not a
  // live situation, which is the same reason the selection is ordered at
  // all.
  //
  // `kind` is restricted to the review kinds for the same reason the
  // verdict is tested: `Verdict` is a column on `Artifact` generally, so
  // without it a `plan_review` — or any future kind that carries one —
  // can be the row this entry speaks about.
  const rows = await db.$queryRawUnsafe<
    {
      findingCount: number;
      reviewRound: number | null;
      verdict: string | null;
      hasFollowUp: boolean;
    }[]
  >(
    `SELECT CASE
              WHEN jsonb_typeof("findings") = 'array' THEN jsonb_array_length("findings")
              ELSE 0
            END::int                          AS "findingCount",
            "reviewRound"                     AS "reviewRound",
            "verdict"::text                   AS "verdict",
            ("followUpItemId" IS NOT NULL)    AS "hasFollowUp"
       FROM "Artifact"
      WHERE "itemId" = $1
        AND "verdict" IS NOT NULL
        AND "kind"::text IN ('code_review', 'visual_review', 'plan_review')
      ORDER BY "createdAt" DESC, "seq" DESC
      LIMIT 1`,
    itemId,
  );

  const row = rows[0];
  if (row === undefined) return {};
  // The verdict this entry is about, and only it. `changes_required` is the
  // verdict *most* likely to carry findings, and it is already blocking —
  // nudging about its findings would fire on the commonest review there is,
  // and this entry is the one timed `immediate`, so it would not even be
  // batched.
  if (row.verdict !== "lgtm_with_nits") return {};
  // A linked follow-up is exactly the remedy this entry asks for. Nudging
  // the reviewer who already did it is how a guard teaches its users to
  // ignore it.
  if (row.hasFollowUp) return {};
  if (row.findingCount < 1) return {};
  return {
    untrackedNits: {
      findingCount: row.findingCount,
      ...(row.reviewRound === null ? {} : { reviewRound: row.reviewRound }),
    },
  };
}

/**
 * How many items are waiting on a visual review right now — I25.
 *
 * **This entry shipped with no assembler at all.** Its predicate reads
 * `pendingVisualReviews`, the field was declared, and nothing in this file
 * ever wrote it — so the entry could not fire, in any installation, ever.
 * That is precisely the failure `./builtins.ts` warns about twice in its own
 * header: *"a registry entry that cannot trigger is worse than an absent
 * one: it reads as coverage on the settings page and provides none."* The
 * signal was available the whole time (`Item.needsVisualReview` is a column);
 * only the wiring was missing.
 *
 * ── Counted across the board, not for this session ─────────────────────
 *
 * The entry is about **concurrency**, which is a property of the queue
 * rather than of any one item — so this deliberately takes no `itemId`. An
 * orchestrator deciding whether to batch needs to know how many are in
 * flight altogether, and a count scoped to its own claim would answer at
 * most one and never trigger.
 *
 * ── What "waiting" means ───────────────────────────────────────────────
 *
 * Flagged as needing a visual review, not yet closed, and with no visual
 * review artifact recorded. Archived and terminal rows are excluded because
 * an item nobody can act on is not a batching opportunity — including them
 * would let long-closed history accumulate into a permanent standing nudge.
 */
async function pendingVisualReviewsFor(
  db: TransactionHandle,
): Promise<Pick<InterventionContext, "pendingVisualReviews">> {
  // `TERMINAL_STATES` rather than a list written out here, for the reason
  // `findings.ts` gives about the severity ladder: a second copy of a
  // vocabulary is free to drift from the first, in a place no test reads.
  // The hand-written version of this query got it wrong in both directions
  // at once — it invented a `done` state the enum does not have, and
  // omitted `research_done`, which it does. Bound as a parameter and
  // compared as text, the same shape `list-items.ts` and `search.ts` use.
  const rows = await db.$queryRawUnsafe<{ pending: number }[]>(
    `SELECT COUNT(*)::int AS "pending"
       FROM "Item" i
      WHERE i."needsVisualReview" = true
        AND i."archivedAt" IS NULL
        AND NOT (i."state"::text = ANY($1::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM "Artifact" a
           WHERE a."itemId" = i."id" AND a."kind" = 'visual_review'
        )`,
    TERMINAL_STATES,
  );

  const row = rows[0];
  // No row at all is the server not having answered, which is "cannot
  // tell" rather than zero. Zero is a real count and is carried through —
  // the predicate is silent at anything below two regardless.
  if (row === undefined) return {};
  return { pendingVisualReviews: row.pending };
}

/**
 * How many distinct items this session's crew holds at once.
 *
 * ── Why the root session, and not the machine or the board ─────────────
 *
 * `Assignment.rootSessionId` is the field that already means "one crew" —
 * `occupancyFor` above compares on it for exactly this reason, because a
 * worker its own orchestrator spawned is not a stranger. Counting on it
 * here answers the only question the reader can act on: *how wide have I
 * spread myself right now.* A board-wide count would fold in every other
 * orchestrator's crews, which is a number this session cannot do anything
 * about and would fire on a healthy busy system.
 *
 * ── Why DISTINCT items rather than assignments ─────────────────────────
 *
 * Because the cost this measures is breadth of work in flight, and two
 * agents on one item — a builder and its reviewer, which is the normal and
 * correct shape — are not two fronts. Counting assignments would make the
 * ordinary review handoff look like a widening crew and fire on the very
 * pattern the system is trying to encourage.
 *
 * ── Live assignments only ──────────────────────────────────────────────
 *
 * `releasedAt IS NULL`, so a retired crewmate stops counting the moment it
 * releases. Without that the number would only ever climb, and a session
 * that had correctly finished four items in sequence would be nudged as
 * though it were running four at once.
 */
async function crewWidthFor(
  db: TransactionHandle,
  claim: AssignmentRow,
): Promise<Pick<InterventionContext, "concurrentCrewItems" | "crewTerritory">> {
  // No null guard on `rootSessionId`: `Assignment.rootSessionId` is
  // non-nullable in the schema, and `occupancyFor` above already relies on
  // that by comparing it directly. A defensive check here would be dead
  // code asserting the opposite of what the column guarantees.
  //
  // **Rows rather than a count**, since the owner's ask added the worktree
  // question. The width is derived from the same rows by counting distinct
  // items here instead of in SQL — one read answering both questions, which
  // is what keeps a dispatch at the one query it already cost.
  const rows = await db.$queryRawUnsafe<{ itemId: string; worktree: string | null }[]>(
    `SELECT a."itemId" AS "itemId", a."worktree" AS "worktree"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
      WHERE a."rootSessionId" = $1
        AND a."releasedAt" IS NULL
        AND i."archivedAt" IS NULL
        AND NOT (i."state"::text = ANY($2::text[]))
      LIMIT $3`,
    claim.rootSessionId,
    TERMINAL_STATES,
    CREW_ROW_LIMIT,
  );

  // No rows is ambiguous in a way the count form was not: a crew always
  // includes the asking session, so an empty result means the query did not
  // answer rather than that the crew is empty. Treated as "cannot tell",
  // the same reading every other optional field here takes.
  if (rows.length === 0) return {};

  const items = new Set(rows.map((row) => row.itemId));

  // ── The worktree question, answered per ITEM rather than per row ──────
  //
  // Two agents on one item — a builder and its reviewer — legitimately
  // share a worktree, and that is the normal shape rather than a
  // collision. Grouping by item first is what stops the healthy handoff
  // being reported as an overlap; what the entry is about is two *fronts*
  // landing in one tree.
  const treesByItem = new Map<string, Set<string>>();
  let unrecorded = 0;
  for (const row of rows) {
    const normalised = normaliseWorktree(row.worktree);
    if (normalised === undefined) {
      unrecorded += 1;
      continue;
    }
    const seen = treesByItem.get(normalised) ?? new Set<string>();
    seen.add(row.itemId);
    treesByItem.set(normalised, seen);
  }

  // A tree holding more than one item is a genuine overlap. The raw path is
  // carried for the message rather than the normalised one — `claimedWorktree`'s
  // own note explains why: a normalised form is the right thing to compare
  // and the wrong thing to display, because lowercased and slash-flipped it
  // stops resembling the string the caller sent.
  const sharedTrees = [...treesByItem.entries()]
    .filter(([, itemIds]) => itemIds.size > 1)
    .map(([normalised, itemIds]) => ({
      worktree:
        rows.find((row) => normaliseWorktree(row.worktree) === normalised)?.worktree ?? normalised,
      itemIds: [...itemIds].sort(),
    }))
    .sort((left, right) => left.worktree.localeCompare(right.worktree));

  return {
    concurrentCrewItems: items.size,
    crewTerritory: {
      sharedTrees,
      // The count of claims that recorded no worktree at all. `worktree` is
      // optional on `claim`, so this is common rather than exceptional —
      // and it is the difference between "the territories are disjoint" and
      // "I could not check", which the entry must not conflate.
      unrecordedWorktrees: unrecorded,
    },
  };
}

/**
 * Whether this item's visual review was deferred with nothing recording it.
 *
 * ── The three conditions, and why all three are needed ─────────────────
 *
 * The finding is a conjunction, and dropping any limb breaks it in a way
 * worth naming:
 *
 *   1. **`needsVisualReview`** — without it this would fire on every item
 *      that never needed a visual review, which is most of the board.
 *   2. **A terminal state** — the entry is about a row that is *closing*.
 *      Firing on an open item would nudge work that simply has not reached
 *      its review yet, which is every item mid-flight.
 *   3. **No visual review artifact, and no artifact linking a follow-up.**
 *      The first is the review itself having happened; the second is the
 *      deferral having been recorded the way `Artifact.followUpItemId` is
 *      already used for `lgtm_with_followups`. Either one is a complete
 *      answer, so both must be absent for there to be a finding at all.
 *
 * ── Why `followUpItemId` on ANY artifact, not just a visual review ─────
 *
 * Because the deferral is recorded by the artifact that *stood in for* the
 * review — most naturally the code review that merged the work, carrying a
 * link to the item minted to do the visual pass later. Requiring the link
 * to hang off a `visual_review` artifact would require the reviewer to
 * record a visual review in order to say that it had not done one, which is
 * the bookkeeping-for-its-own-sake shape that teaches callers to route
 * around a guard.
 *
 * Returns a real `false` when the question was asked and the item is fine —
 * distinct from absent, which is the question not having been asked.
 */
async function deferredVisualReviewFor(
  db: TransactionHandle,
  itemId: string,
): Promise<Pick<InterventionContext, "visualReviewDeferredUnrecorded">> {
  const rows = await db.$queryRawUnsafe<{ deferred: boolean }[]>(
    `SELECT (
              i."needsVisualReview" = true
              AND i."state"::text = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM "Artifact" a
                 WHERE a."itemId" = i."id" AND a."kind" = 'visual_review'
              )
              AND NOT EXISTS (
                SELECT 1 FROM "Artifact" a
                 WHERE a."itemId" = i."id" AND a."followUpItemId" IS NOT NULL
              )
            ) AS "deferred"
       FROM "Item" i
      WHERE i."id" = $1`,
    itemId,
    TERMINAL_STATES,
  );

  const row = rows[0];
  // No row means the item vanished between the claim lookup and this query,
  // which is "cannot tell" rather than a finding.
  if (row === undefined) return {};
  return { visualReviewDeferredUnrecorded: row.deferred };
}
