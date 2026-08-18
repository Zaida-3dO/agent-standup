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
import { currentTipCommitSha } from "@/lib/service/guards/artifact-tip";
import { hasApprovingArtifactAtCurrentRoundAndTip } from "@/lib/service/guards/merge-review-round";
import { isMergeAttempt } from "./commands";
import { isBroadGitAdd } from "./builtins";
import type { InterventionContext } from "./types";

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
}

const NOTHING: ContextNeeds = { assignment: false, approval: false, occupancy: false };

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
export function needs(command: string | undefined, tool?: string): ContextNeeds {
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

  if (command === undefined || command.trim() === "") {
    return occupancy ? { assignment: true, approval: false, occupancy: true } : NOTHING;
  }

  // A merge attempt is the only shape that needs to know whether an
  // approval sits at the tip, and it needs the assignment first in order to
  // know *which item's* tip to ask about.
  if (isMergeAttempt(command)) return { assignment: true, approval: true, occupancy };

  // A broad `git add` needs to know whether the checkout is shared, which
  // is the claim's `worktree` — no artifact question is involved.
  if (isBroadGitAdd(command)) return { assignment: true, approval: false, occupancy };

  return occupancy ? { assignment: true, approval: false, occupancy: true } : NOTHING;
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
  lastActiveSecondsAgo: number | null;
}

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
}): Promise<InterventionContext> {
  const { db, sessionId, tool, command } = options;

  const base: InterventionContext = {
    sessionId,
    ...(tool === undefined ? {} : { tool }),
    ...(command === undefined ? {} : { command }),
  };

  const wanted = needs(command, tool);
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
  if (claim === undefined) return base;

  const withClaim: InterventionContext = {
    ...base,
    itemId: claim.itemId,
    itemState: claim.state,
    // A claim records the worktree it was taken in. A non-empty value means
    // a linked worktree with its own index; `null` means the claim never
    // recorded one, which is **unknown**, not "the shared checkout" — so
    // the field stays absent rather than becoming `false`.
    ...(claim.worktree === null ? {} : { isLinkedWorktree: claim.worktree.trim() !== "" }),
  };

  // I15 — who else holds this checkout. Keyed on `(machine, repo)` and
  // compared on ROOT sessions, for the reasons the entry itself records:
  // `worktree` is unnormalised free text that does not compare equal across
  // spellings, and a worker its own orchestrator spawned shares the
  // checkout legitimately.
  const withOccupancy = wanted.occupancy
    ? { ...withClaim, ...(await occupancyFor(db, claim)) }
    : withClaim;

  if (!wanted.approval) return withOccupancy;

  // The merge gate's own primitives, reused rather than reimplemented. If
  // this asked the question differently from the guard that enforces it at
  // `transition_item`, the two would eventually disagree — and the version
  // that disagreed would be the one blocking a session's shell command with
  // no way to see why.
  const tip = await currentTipCommitSha(db, claim.itemId);
  const approved = await hasApprovingArtifactAtCurrentRoundAndTip(db, claim.itemId, "code_review");

  return {
    ...withOccupancy,
    // With no commit artifact at all there is no tip for an approval to be
    // at, so "is there an approval at tip" has no true answer and the field
    // stays absent. An item nobody has committed to is not an item somebody
    // is merging without review; it is one that has not got there yet.
    ...(tip === null ? {} : { hasApprovalAtTip: approved }),
    ...(claim.defaultBranch === null ? {} : { defaultBranch: claim.defaultBranch }),
  };
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

  const rows = await db.$queryRawUnsafe<OccupancyRow[]>(
    `SELECT a."rootSessionId" AS "rootSessionId",
            a."itemId"        AS "itemId",
            a."branch"        AS "branch",
            FLOOR(EXTRACT(EPOCH FROM (NOW() - a."lastActive")))::int AS "lastActiveSecondsAgo"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
      WHERE a."machine" = $1
        AND i."repo" = $2
        AND a."rootSessionId" <> $3
        AND a."releasedAt" IS NULL
        AND a."liveness" = 'running'
      ORDER BY a."lastActive" DESC
      LIMIT 1`,
    claim.machine,
    claim.repo,
    claim.rootSessionId,
  );

  const holder = rows[0];
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
