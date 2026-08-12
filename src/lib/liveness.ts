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
}

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

export interface LivenessSweepResult {
  readonly checkedAt: Date;
  readonly moves: readonly AssignmentMove[];
  readonly released: readonly string[];
  readonly escalated: readonly EscalatedItem[];
  readonly capabilityChecks: readonly CapabilityCheckOutcome[];
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
  options: { readonly now?: Date; readonly guards?: GuardRegistry } = {},
): Promise<LivenessSweepResult> {
  const now = options.now ?? new Date();
  const guards = options.guards ?? guardRegistry;
  const staleAfterSeconds = settings.values["liveness.stale_after_seconds"];
  const deadAfterSeconds = settings.values["liveness.dead_after_seconds"];
  const resumeAttemptsBeforeBlocked = settings.values["dispatch.resume_attempts_before_blocked"];

  const rows = await db.$queryRawUnsafe<LiveAssignmentRow[]>(
    `SELECT "id", "itemId", "liveness", "lastActive", "holderType", "holderId", "sessionId"
     FROM "Assignment"
     WHERE "releasedAt" IS NULL AND "liveness" IN ('running', 'stalled')`,
  );

  const moves: AssignmentMove[] = [];
  const released: string[] = [];
  const escalated: EscalatedItem[] = [];

  for (const row of rows) {
    const quietForSeconds = (now.getTime() - row.lastActive.getTime()) / 1000;
    const rung = nextLivenessRung({ quietForSeconds, staleAfterSeconds, deadAfterSeconds });

    // `nextLivenessRung` can only report `running`, `stalled` or `dead` —
    // it is never asked about a row already past `stalled` (the query above
    // excludes `dead`/`superseded`), and it is a total function over its
    // three-way return, so `rung === row.liveness` is the only "no move"
    // case left standing.
    if (rung === row.liveness) continue;

    await db.$executeRawUnsafe(
      `UPDATE "Assignment" SET "liveness" = $1::"Liveness" WHERE "id" = $2`,
      rung,
      row.id,
    );
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
    await db.$executeRawUnsafe(
      `UPDATE "Assignment" SET "releasedAt" = $1 WHERE "id" = $2`,
      now,
      row.id,
    );
    released.push(row.id);

    await appendEvent(db, {
      itemId: row.itemId,
      actor: { actorType: actor.actorType, actorId: actor.actorId },
      assignmentId: row.id,
      type: "release",
      payload: { assignmentId: row.id, role: null, holderId: row.holderId },
      body: "Released by the liveness sweep: no activity past the dead threshold.",
    });

    const attemptRows = await db.$queryRawUnsafe<{ resumeAttempts: number; state: string }[]>(
      `UPDATE "Item" SET "resumeAttempts" = "resumeAttempts" + 1, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING "resumeAttempts", "state"`,
      row.itemId,
    );
    const itemRow = attemptRows[0];
    if (!itemRow) {
      // The assignment referenced an item that no longer exists. Nothing
      // further to escalate — the row above already recorded the release.
      continue;
    }

    if (itemRow.resumeAttempts >= resumeAttemptsBeforeBlocked && itemRow.state !== "blocked") {
      await escalateToBlocked(db, {
        itemId: row.itemId,
        resumeAttempts: itemRow.resumeAttempts,
        actor,
        settings,
        guards,
      });
      escalated.push({ itemId: row.itemId, resumeAttempts: itemRow.resumeAttempts });
    }
  }

  const capabilityChecks = await sweepCapabilityDocuments(db, settings, actor, now);

  return { checkedAt: now, moves, released, escalated, capabilityChecks };
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
): Promise<CapabilityCheckOutcome[]> {
  const outcomes: CapabilityCheckOutcome[] = [];

  for (const key of CAPABILITY_KEYS) {
    const path = settings.values[key];
    if (path === null) continue;

    const result = await resolveCapabilityResult(path, fs);
    outcomes.push({ key, path, result });

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
