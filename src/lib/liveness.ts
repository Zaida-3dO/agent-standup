// The liveness sweep (SCHEMA.md §2, §17.2, §17.5; MILESTONES.md #24).
//
// Two independent things happen on the same periodic pass, because the doc
// this milestone quotes says so in one sentence: the quiet -> stalled ->
// dead ladder over live assignments, with resume attempts escalating an
// item to `blocked`; and the capability-document re-check DECISIONS.md
// §13f describes as "the sweep that already runs for liveness". They share
// nothing structurally — one walks `Assignment`, the other walks two
// settings keys — but they are one function because they are one
// operational event: "the periodic pass ran, here is everything it found."
//
// **Time is injected, never read from `Date.now()` inside the ladder
// itself.** `nextLivenessRung` (the rung decision) takes `now` as a
// parameter, so a test proves "at T+899s nothing fires, at T+901s it does"
// without a real sleep — see tests/liveness.test.ts for why that matters
// more here than almost anywhere else in this repository.
import { holderHasNeverSignalled } from "./claim-eviction";
import { NotFoundError } from "./service/errors";
import { applyTransition } from "./service/state-machine/transition";
import { guardRegistry, type GuardRegistry } from "./service/state-machine/guard";
import { appendEvent } from "./events";
import type { TransactionHandle } from "./service/context";
import type { SettingsSnapshot } from "./settings";

// ---------------------------------------------------------------------------
// The ladder — pure, no database, no clock of its own.
// ---------------------------------------------------------------------------

export type LivenessRung = "running" | "stalled" | "dead";

/**
 * How far behind its own `claimedAt` an assignment's `lastActive` may sit
 * and still count as "never stamped" rather than "stamped with something
 * odd".
 *
 * Both columns are `@default(now())`, and Postgres evaluates the two
 * defaults in one INSERT as separate `now()` calls, so on an untouched row
 * they are equal or differ by a rounding artefact — the schema stores
 * `Timestamptz(3)`, i.e. millisecond precision, so the largest difference
 * an insert can manufacture is one millisecond. One second is three orders
 * of magnitude of headroom over that and still four orders below the
 * tightest liveness threshold (`stale_after_seconds`, default 900), so it
 * cannot be reached by any real activity gap that matters here.
 *
 * It is a constant rather than a setting deliberately: it describes how the
 * database fills two columns, which is not a thing an operator should be
 * asked to tune, and exposing it would invite raising it into a way to
 * exempt live rows from reclamation.
 */
const CLAIM_STAMP_ORDERING_ALLOWANCE_MS = 1_000;

/**
 * Where one assignment sits on the ladder right now, given how long it has
 * been quiet and the two configured thresholds.
 *
 * Three rungs, two thresholds, ordered so a longer quiet period can only
 * move *forward* — `dead_after_seconds` is checked first precisely because
 * an assignment quiet long enough to be dead is *also* quiet long enough to
 * be stalled, and the more severe rung must win that overlap. `superseded`
 * is deliberately not a rung this function ever returns: SCHEMA.md §2's
 * first invariant is that a `superseded` assignment cannot be `running`
 * again, and the second is that a rejected call after supersession is not
 * activity — both are about *how* liveness stops changing once superseded,
 * not about where it moves *to* on this ladder, so the sweep must never
 * ask this function to reconsider a superseded row (`sweepLiveness` filters
 * those out before calling it).
 */
export function nextLivenessRung(args: {
  readonly quietForSeconds: number;
  readonly staleAfterSeconds: number;
  readonly deadAfterSeconds: number;
}): LivenessRung {
  const { quietForSeconds, staleAfterSeconds, deadAfterSeconds } = args;
  if (quietForSeconds >= deadAfterSeconds) return "dead";
  if (quietForSeconds >= staleAfterSeconds) return "stalled";
  return "running";
}

// ---------------------------------------------------------------------------
// The ladder — against the database.
// ---------------------------------------------------------------------------

interface LiveAssignmentRow {
  id: string;
  itemId: string;
  liveness: LivenessRung | "superseded";
  lastActive: Date;
  holderType: "person" | "agent";
  holderId: string;
  sessionId: string;
  /** `Assignment.claimedAt` — where `lastActive` sits until something stamps it. */
  claimedAt: Date;
  /** The holder session's most recent `ToolCall.ts`, or null when it has none. */
  lastToolCallAt: Date | null;
  /** `Session.hookVersion` — null when the session never registered, or named no version. */
  holderHookVersion: number | null;
}

/**
 * The body written on the `release` event when the sweep takes a claim back.
 *
 * Exported because it is read as well as written. `get_stale_candidates`
 * distinguishes a claim the *server* reclaimed from one a holder gave up
 * deliberately, and this string is the only durable record of which
 * happened: the actor is supplied by whoever runs the sweep, so it cannot
 * be relied on to say `system`. Sharing the constant is what keeps the
 * reader and the writer from drifting into disagreeing about the same
 * event — a matcher against a copied literal would silently stop matching
 * the day this wording was improved.
 */
export const SWEEP_RELEASE_BODY =
  "Released by the liveness sweep: no activity past the dead threshold.";

/** Who ran the sweep — recorded on both the assignment moves and the capability checks. */
export interface SweepActor {
  readonly actorType: "agent" | "system";
  readonly actorId: string | null;
}

export interface AssignmentMove {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly from: "running" | "stalled";
  readonly to: LivenessRung;
}

export interface EscalatedItem {
  readonly itemId: string;
  readonly resumeAttempts: number;
}

export interface CapabilityCheckOutcome {
  readonly key: string;
  readonly path: string;
  readonly result: "exists" | "missing" | "unverified";
}

/**
 * A holder quiet past the dead threshold that was **not** released, because
 * it has emitted no signal at all and has no hook to emit one with.
 *
 * Reported rather than merely skipped: an operator who ran a sweep expecting
 * a claim to be reclaimed needs to know that it deliberately was not, and
 * why, or the exemption looks like the sweep failing to do its job. Each of
 * these is reclaimable by hand through `takeover`.
 */
export interface ExemptedHolder {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly sessionId: string;
  /**
   * How long the holder has been quiet. Reported because it is the number
   * that *would* have released the claim, so the exemption can be judged.
   * Note this is measured from `lastActive`, which for this holder is still
   * its `claimedAt` — so it is really the age of the claim.
   */
  readonly quietForSeconds: number;
}

export interface LivenessSweepResult {
  readonly checkedAt: Date;
  readonly moves: readonly AssignmentMove[];
  readonly released: readonly string[];
  readonly escalated: readonly EscalatedItem[];
  readonly capabilityChecks: readonly CapabilityCheckOutcome[];
  /**
   * Holders past the dead threshold that were deliberately left alone. See
   * `ExemptedHolder`, and the exemption's reasoning at its use site below.
   */
  readonly exempted: readonly ExemptedHolder[];
  /**
   * True when this pass wrote nothing — every field above describes what
   * *would* have happened rather than what did.
   */
  readonly dryRun: boolean;
}

/**
 * Advances every non-superseded live assignment along the ladder, releases
 * whatever just went `dead`, and escalates the owning item to `blocked`
 * once its resume attempts reach `dispatch.resume_attempts_before_blocked`.
 *
 * **Runs entirely inside the caller's transaction** (`db` is a
 * `TransactionHandle`, the same narrowing every other service-layer module
 * uses) — a sweep that moved half its rows and then failed would leave the
 * ladder in a state nothing chose, so either the whole pass commits or none
 * of it does.
 *
 * A newly-`stalled` row is not itself a resume attempt — going `stalled` is
 * quiet, not an attempt to resume. **A resume attempt is recorded exactly
 * when a `dead` assignment's claim is released**, because that is the
 * moment a subsequent claim on the item becomes possible again — SCHEMA.md
 * §1's `resume_attempts` counts "dispatch attempts since the last durable
 * progress", and release-of-a-dead-claim is what makes the next dispatch
 * attempt possible. Escalation checks the counter *after* incrementing it,
 * so an item whose count reaches the threshold on this exact sweep is
 * escalated on this same pass rather than the next one.
 */
export async function sweepLiveness(
  db: TransactionHandle,
  settings: SettingsSnapshot,
  actor: SweepActor,
  options: {
    readonly now?: Date;
    readonly guards?: GuardRegistry;
    /**
     * Report what this pass would do, and write nothing at all.
     *
     * Every write in this function is behind this flag — the rung `UPDATE`,
     * the release, the release event, the resume-attempt increment, the
     * escalation, and the capability-check upsert. The returned result is
     * otherwise identical in shape and content to a real pass, so a caller
     * reads a rehearsal exactly as it reads the thing it is rehearsing.
     *
     * Reading stays live: the rows below are read from the database as
     * normal, so a rehearsal reports on the real current state rather than
     * on a simulation of it.
     *
     * One consequence worth stating because it is easy to expect otherwise.
     * The escalation check reads a resume-attempt count that a real pass
     * would have incremented; under a rehearsal nothing is incremented, so
     * the count is read as it stands and the escalation decision is made on
     * the incremented value in memory without the write. That keeps the
     * reported escalations faithful to what a real pass would do.
     */
    readonly dryRun?: boolean;
  } = {},
): Promise<LivenessSweepResult> {
  const now = options.now ?? new Date();
  const guards = options.guards ?? guardRegistry;
  const dryRun = options.dryRun ?? false;
  const staleAfterSeconds = settings.values["liveness.stale_after_seconds"];
  const deadAfterSeconds = settings.values["liveness.dead_after_seconds"];
  const resumeAttemptsBeforeBlocked = settings.values["dispatch.resume_attempts_before_blocked"];

  // The two correlated subqueries are what let this pass ask
  // `holderHasNeverSignalled` the same question the lazy eviction path asks.
  // There is deliberately no join to `Session`: it has no foreign key from
  // `Assignment` (a session may hold a claim without ever registering), so an
  // inner join would silently drop exactly the holders this exemption is
  // about, and a left join would say the same thing as this at more width.
  const rows = await db.$queryRawUnsafe<LiveAssignmentRow[]>(
    `SELECT a."id", a."itemId", a."liveness", a."lastActive", a."holderType", a."holderId",
            a."sessionId", a."claimedAt",
            (SELECT MAX(t."ts") FROM "ToolCall" t WHERE t."sessionId" = a."sessionId")
              AS "lastToolCallAt",
            (SELECT s."hookVersion" FROM "Session" s WHERE s."id" = a."sessionId")
              AS "holderHookVersion"
     FROM "Assignment" a
     WHERE a."releasedAt" IS NULL AND a."liveness" IN ('running', 'stalled')`,
  );

  const moves: AssignmentMove[] = [];
  const released: string[] = [];
  const escalated: EscalatedItem[] = [];
  const exempted: ExemptedHolder[] = [];

  for (const row of rows) {
    const quietForSeconds = (now.getTime() - row.lastActive.getTime()) / 1000;
    let rung = nextLivenessRung({ quietForSeconds, staleAfterSeconds, deadAfterSeconds });

    // ── The exemption, shared with the lazy eviction path ──
    //
    // A holder that has emitted no signal at all since claiming, and whose
    // registration names no hook to emit one with, is not quiet because it
    // died — it is quiet because that is the only way it was ever going to
    // be. Its `lastActive` is frozen at `claimedAt` by construction, so
    // `quietForSeconds` above is measuring the age of the claim and calling
    // it silence. Reading that as death is reading the absence of a
    // mechanism as the absence of a session.
    //
    // The rule is shared with `judgeEviction`, and has to be. That path can
    // reach the same holder at contention, and the operator-facing help on
    // `liveness.evict_after_seconds` states the exemption as the product's
    // behaviour. This pass runs on a threshold eight times tighter, so if it
    // answered differently the holder's fate would turn on which route
    // happened to reach it first — and the tighter route would win, taking
    // the claim of a session that is quietly working.
    //
    // **The exemption caps the rung at `stalled`; it does not hide the
    // holder.** Two reasons, and the distinction is the whole design:
    //
    //   - `dead` is not merely a label here. It is the rung that releases
    //     the claim, and releasing a live session's claim is the harm — it
    //     produces two sessions that each believe they own the item, which
    //     is neither visible nor recoverable. That is the outcome this
    //     declines.
    //   - `stalled` is a label and nothing else. Nothing is released, no
    //     resume attempt is counted, no item is escalated. So the holder is
    //     still surfaced as quiet to anyone reading the board, which is what
    //     an operator needs in order to notice a genuinely dead unhooked
    //     session and reach for `takeover`. Suppressing the move entirely
    //     would trade a false eviction for an invisible stranded claim.
    //
    // What is given up is stated plainly in `claim-eviction.ts`: an unhooked
    // session that dies inside its first signal-less stretch keeps its claim
    // until somebody takes it over by hand. That is a bounded, visible,
    // reversible cost, and it is the same trade the other path already made.
    // The escape is unchanged: one `heartbeat` call moves `lastActive` off
    // `claimedAt` and puts the holder back under ordinary judgement forever.
    // The third condition is not redundant with `holderHasNeverSignalled`,
    // and the ordinary sweep tests are what demonstrate it: without this
    // term, rows those tests expect to be reclaimed are exempted instead.
    // That predicate asks `lastSeen <=
    // claimedAt`, and its `<=` is deliberately loose — it defends against
    // the two `@default(now())` columns being filled by separate `now()`
    // calls within one INSERT, where `lastActive` can land a fraction of a
    // millisecond *behind* `claimedAt` on a row that is perfectly ordinary.
    //
    // That looseness is right for the question it was written to answer, but
    // it admits a second state that is not the exempt one: a row whose
    // `lastActive` sits materially *earlier* than its own claim. Such a row
    // is not a fresh holder that has said nothing — its activity column
    // holds a value from before the claim existed, which is an inconsistency
    // rather than silence, and reading it as "never signalled" would hand an
    // indefinite claim to a row nobody reasoned about. A safety carve-out
    // that fires on an unconsidered state is how a carve-out becomes a hole.
    //
    // So the sweep additionally requires that `lastActive` has not moved
    // *backwards* from the claim by more than that insert-ordering
    // allowance. The predicate is left exactly as the eviction path defines
    // it: this is the sweep declining to widen a shared safety rule to suit
    // itself, not a disagreement about what the rule means.
    const lastActiveBehindClaimByMs = row.claimedAt.getTime() - row.lastActive.getTime();
    const withinInsertOrderingAllowance =
      lastActiveBehindClaimByMs <= CLAIM_STAMP_ORDERING_ALLOWANCE_MS;

    const exemptFromRelease =
      rung === "dead" &&
      row.holderHookVersion === null &&
      withinInsertOrderingAllowance &&
      holderHasNeverSignalled({
        lastActive: row.lastActive,
        claimedAt: row.claimedAt,
        lastToolCallAt: row.lastToolCallAt,
      });

    if (exemptFromRelease) {
      exempted.push({
        assignmentId: row.id,
        itemId: row.itemId,
        sessionId: row.sessionId,
        quietForSeconds: Math.round(quietForSeconds),
      });
      rung = "stalled";
    }

    // `nextLivenessRung` can only report `running`, `stalled` or `dead` —
    // it is never asked about a row already past `stalled` (the query above
    // excludes `dead`/`superseded`), and it is a total function over its
    // three-way return, so `rung === row.liveness` is the only "no move"
    // case left standing.
    if (rung === row.liveness) continue;

    if (!dryRun) {
      await db.$executeRawUnsafe(
        `UPDATE "Assignment" SET "liveness" = $1::"Liveness" WHERE "id" = $2`,
        rung,
        row.id,
      );
    }
    moves.push({
      assignmentId: row.id,
      itemId: row.itemId,
      from: row.liveness as "running" | "stalled",
      to: rung,
    });

    if (rung !== "dead") continue;

    // Going dead releases the claim (SCHEMA.md §2's ladder: "Stalled ->
    // dead, claim released") and, because that is what makes the item
    // dispatchable again, counts as one resume attempt on the item.
    if (!dryRun) {
      await db.$executeRawUnsafe(
        `UPDATE "Assignment" SET "releasedAt" = $1 WHERE "id" = $2`,
        now,
        row.id,
      );
    }
    released.push(row.id);

    if (!dryRun) {
      await appendEvent(db, {
        itemId: row.itemId,
        actor: { actorType: actor.actorType, actorId: actor.actorId },
        assignmentId: row.id,
        type: "release",
        payload: { assignmentId: row.id, role: null, holderId: row.holderId },
        body: SWEEP_RELEASE_BODY,
      });
    }

    // The increment and the read are one statement in a real pass. A
    // rehearsal cannot use it — `UPDATE ... RETURNING` writes — so it reads
    // the current row instead and adds the one it would have added, which
    // is the value the escalation check below must see to stay faithful.
    // Reading and incrementing separately would be a race in a real pass;
    // here it is safe precisely because nothing is written.
    const attemptRows = dryRun
      ? await db.$queryRawUnsafe<{ resumeAttempts: number; state: string }[]>(
          `SELECT "resumeAttempts" + 1 AS "resumeAttempts", "state" FROM "Item" WHERE "id" = $1`,
          row.itemId,
        )
      : await db.$queryRawUnsafe<{ resumeAttempts: number; state: string }[]>(
          `UPDATE "Item" SET "resumeAttempts" = "resumeAttempts" + 1, "updatedAt" = now()
           WHERE "id" = $1
           RETURNING "resumeAttempts", "state"`,
          row.itemId,
        );
    const itemRow = attemptRows[0];
    if (!itemRow) {
      // The `UPDATE` matched nothing, so this item does not exist. Nothing
      // further to escalate — the row above already recorded the release.
      continue;
    }

    if (itemRow.resumeAttempts >= resumeAttemptsBeforeBlocked && itemRow.state !== "blocked") {
      if (!dryRun) {
        await escalateToBlocked(db, {
          itemId: row.itemId,
          resumeAttempts: itemRow.resumeAttempts,
          actor,
          settings,
          guards,
        });
      }
      escalated.push({ itemId: row.itemId, resumeAttempts: itemRow.resumeAttempts });
    }
  }

  const capabilityChecks = await sweepCapabilityDocuments(
    db,
    settings,
    actor,
    now,
    undefined,
    dryRun,
  );

  return { checkedAt: now, moves, released, escalated, capabilityChecks, exempted, dryRun };
}

/**
 * Moves an item to `blocked` through the real, guarded transition path
 * (`applyTransition`) rather than a raw `UPDATE` — the same row #16 guards
 * every other caller answers to run here too, so an escalated item is
 * indistinguishable in the data from one a person blocked by hand.
 *
 * `blocked_on_type: "external_process"` — never `person` — because nothing
 * about exhausting resume attempts identifies a person to wait on; that is
 * exactly what distinguishes an automatic escalation from someone
 * deliberately blocking an item on themselves or another person.
 */
async function escalateToBlocked(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly resumeAttempts: number;
    readonly actor: SweepActor;
    readonly settings: SettingsSnapshot;
    readonly guards: GuardRegistry;
  },
): Promise<void> {
  const ctx = { db, settings: args.settings, caller: {}, operation: "liveness.sweep" };
  try {
    await applyTransition(
      ctx,
      {
        itemId: args.itemId,
        to: "blocked",
        fields: {
          blocked_reason: `Escalated by the liveness sweep after ${args.resumeAttempts} resume attempts with no durable progress.`,
          blocked_on_type: "external_process",
        },
      },
      args.guards,
    );
  } catch (error) {
    if (error instanceof NotFoundError) return; // Item vanished between the count and the move.
    throw error;
  }

  await appendEvent(db, {
    itemId: args.itemId,
    actor: { actorType: args.actor.actorType, actorId: args.actor.actorId },
    type: "escalation",
    payload: { to_person: null },
    body: `Resume attempts (${args.resumeAttempts}) reached the configured limit with no durable progress; escalated to blocked.`,
  });
}

// ---------------------------------------------------------------------------
// Capability document re-verification — the same sweep, a different table.
// ---------------------------------------------------------------------------

/** The two capability settings this sweep knows how to re-check. See SCHEMA.md §17.5. */
const CAPABILITY_KEYS = ["notify.doc", "visual_review.doc"] as const;

/**
 * Whether `path` looks like it could be checked on *this* filesystem —
 * SCHEMA.md §17.5's "where the server can see that filesystem" question,
 * answered structurally rather than by attempting the read and hoping the
 * failure mode tells us why. A URL is never locally checkable; an absolute
 * filesystem path is attempted; anything else (a bare relative path, an
 * empty string that slipped past the registry schema) is treated the same
 * as "cannot see it" rather than guessed at.
 */
function looksLikeUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

export interface CapabilityFsCheck {
  /** Resolves true/false/unknown for a local filesystem path. Injected so tests never touch disk. */
  exists(path: string): Promise<boolean | "unknown">;
}

/**
 * Re-verifies `notify.doc` and `visual_review.doc` against the filesystem
 * this process can see, and records `{ last_checked_by, last_checked_at,
 * result }` per DECISIONS.md §13f ("checked is a fact about the machine
 * that processed the write... the stored state is who checked it, when,
 * and what they found").
 *
 * A `null` setting is skipped entirely — SCHEMA.md §17.2 says null means
 * the capability is off ("notifications off", "visual review
 * unavailable"), and there is no path to check for a capability that is
 * not configured. This is what stops a fresh installation, where both
 * capabilities default to `null`, from ever writing a row here.
 */
export async function sweepCapabilityDocuments(
  db: TransactionHandle,
  settings: SettingsSnapshot,
  actor: SweepActor,
  now: Date,
  fs: CapabilityFsCheck = defaultFsCheck,
  /**
   * Resolve the paths and report, but do not record the check. The read
   * side stays live — a rehearsal that skipped the filesystem entirely
   * would report a result it had not actually established.
   */
  dryRun = false,
): Promise<CapabilityCheckOutcome[]> {
  const outcomes: CapabilityCheckOutcome[] = [];

  for (const key of CAPABILITY_KEYS) {
    const path = settings.values[key];
    if (path === null) continue;

    const result = await resolveCapabilityResult(path, fs);
    outcomes.push({ key, path, result });

    if (dryRun) continue;

    await db.$executeRawUnsafe(
      `INSERT INTO "capability_checks"
         ("key", "path", "result", "lastCheckedByType", "lastCheckedById", "lastCheckedAt")
       VALUES ($1, $2, $3::"CapabilityCheckResult", $4::"ActorType", $5, $6)
       ON CONFLICT ("key") DO UPDATE SET
         "path" = EXCLUDED."path",
         "result" = EXCLUDED."result",
         "lastCheckedByType" = EXCLUDED."lastCheckedByType",
         "lastCheckedById" = EXCLUDED."lastCheckedById",
         "lastCheckedAt" = EXCLUDED."lastCheckedAt"`,
      key,
      path,
      result,
      actor.actorType,
      actor.actorId,
      now,
    );
  }

  return outcomes;
}

async function resolveCapabilityResult(
  path: string,
  fs: CapabilityFsCheck,
): Promise<CapabilityCheckOutcome["result"]> {
  if (looksLikeUrl(path)) return "unverified"; // The core never fetches a URL to check it (§17.5).
  const found = await fs.exists(path);
  if (found === "unknown") return "unverified";
  return found ? "exists" : "missing";
}

/**
 * The production filesystem check — absolute paths only, `unknown` for
 * anything else (a relative path means nothing without knowing the
 * process's working directory, which is not a fact this module should
 * guess at).
 */
const defaultFsCheck: CapabilityFsCheck = {
  async exists(path: string): Promise<boolean | "unknown"> {
    if (!path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path)) return "unknown";
    try {
      const { access } = await import("node:fs/promises");
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};
