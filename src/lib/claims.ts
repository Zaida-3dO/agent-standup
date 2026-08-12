// Claims (SCHEMA.md §2) — taking ownership of an item, atomically.
//
// Three rules live here, and the difference between how each is enforced is
// the whole point of this module:
//
//   1. **One live orchestrator per item** — a partial unique index in
//      Postgres (`Assignment_one_live_orchestrator_per_item`).
//   2. **One live row per session per item** — a partial unique index in
//      Postgres (`Assignment_one_live_row_per_session_per_item`).
//   3. **One crew per item** — the root-session check, which is application
//      code because no index can express it (see `assertSameCrew`).
//
// Rules 1 and 2 are *not* checked here before writing. The `INSERT` runs,
// and Postgres decides. That is deliberate, and it is the difference
// between a rule and a hope: a check-then-write leaves a window in which
// two concurrent claims both pass the check and both write, and the window
// is short enough that a test will usually miss it and production will not.
// Pushing the decision into the index makes Postgres the thing that
// serialises the race, so there is no window at all.
//
// The same reasoning, and the same mistake, is written up on `ensureArea`
// in areas.ts: `prisma.upsert` is a find followed by a create, two
// round-trips with no atomicity between them, so it is not a
// compare-and-set however much it reads like one.
//
// **Why `ON CONFLICT DO NOTHING` and not a bare `INSERT` with a `catch`.**
// A raised unique violation aborts the enclosing Postgres transaction:
// every subsequent statement fails with `25P02` until the block ends. So a
// bare insert could tell the caller *that* it lost the race but never
// *which rule* refused it or *who* holds the item, because finding that out
// needs a query and an aborted block will not run one. The
// untargeted `ON CONFLICT DO NOTHING` conflicts on **any** unique index on
// the table, including both partial ones, and turns the loss into an empty
// result instead of an error — the race is still resolved by the index,
// atomically, but the transaction survives to explain itself.
import { ConflictError, GuardRejectedError } from "./service/errors";
import { appendEvent } from "./events";
import type { TransactionHandle } from "./service/context";

/** The roles an assignment can hold. Mirrors `Role` in schema.prisma. */
export type Role = "orchestrator" | "builder" | "reviewer" | "visual_reviewer" | "scout" | "custom";

/** Mirrors `HolderType` in schema.prisma. */
export type HolderType = "person" | "agent";

/** Mirrors `Liveness` in schema.prisma. */
export type Liveness = "running" | "stalled" | "dead" | "superseded";

/** The guard identifier the root-session check rejects under. */
export const ROOT_SESSION_GUARD = "claims.one_crew_per_item";

/** The guard identifier the `role`/`roleCustom` pairing rejects under. */
export const CUSTOM_ROLE_GUARD = "claims.custom_role_needs_name";

export interface ClaimInput {
  readonly itemId: string;
  readonly role: Role;
  /** Required iff `role === "custom"`, and meaningless otherwise (SCHEMA.md §2). */
  readonly roleCustom?: string | null;
  readonly holderType: HolderType;
  readonly holderId: string;
  readonly sessionId: string;
  /** Who spawned this session directly. Null for a root. */
  readonly parentSessionId?: string | null;
  /**
   * Top of this session's tree. A root points at itself, so omitting it
   * means "this session is a root" rather than "unknown" — there is no
   * third possibility to represent.
   */
  readonly rootSessionId?: string | null;
  readonly machine: string;
  readonly pid?: number | null;
  readonly branch?: string | null;
  readonly worktree?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

export interface Assignment {
  readonly id: string;
  readonly itemId: string;
  readonly role: Role;
  readonly roleCustom: string | null;
  readonly holderType: HolderType;
  readonly holderId: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly rootSessionId: string;
  readonly machine: string;
  readonly pid: number | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly liveness: Liveness;
  readonly supersededBy: string | null;
  readonly claimedAt: Date;
  readonly lastActive: Date;
  readonly releasedAt: Date | null;
  readonly model: string | null;
  readonly effort: string | null;
}

/**
 * The item's live assignments — the rows the two partial indexes and the
 * crew check all range over. "Live" is `releasedAt IS NULL`, the same
 * predicate the indexes carry, so what this reads and what Postgres
 * enforces cannot disagree about which rows count.
 */
export async function liveAssignments(
  db: TransactionHandle,
  itemId: string,
): Promise<Assignment[]> {
  return db.$queryRawUnsafe<Assignment[]>(
    `SELECT * FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
    itemId,
  );
}

/**
 * The root-session check (SCHEMA.md §2): a claim arriving with a
 * **different** `rootSessionId` than the item's existing live assignments
 * means a second crew has appeared.
 *
 * This one is application code and cannot be anything else. "No live
 * assignment has a *different* root session" is not a uniqueness property
 * of any column or set of columns — a unique index on `(itemId,
 * rootSessionId)` would say the opposite of what is wanted, forbidding an
 * orchestrator and its own builder from both holding the item. So it is a
 * check-then-write, and it carries the race a check-then-write has: two
 * first claims from different crews, arriving concurrently on an item with
 * no live assignment at all, can both see an empty crew and both proceed.
 *
 * That residual window is narrower than it first looks, and it is worth
 * being precise about where it is rather than claiming it away. It is only
 * open for the *first* live claim on an item: once any row is live, a
 * second crew reads it and is refused. And if both racing claims are
 * orchestrators — the shape that actually matters, two crews each driving
 * the same item — index 1 refuses one of them whatever this check saw. What
 * is left unguarded is two *non-orchestrator* first claims from different
 * crews landing in the same instant, which leaves the item with a mixed
 * crew rather than a corrupted one, and which the liveness sweep can see.
 *
 * Rejects with the holder named, per §2 ("name the current holder" rather
 * than failing blankly).
 */
export function assertSameCrew(live: readonly Assignment[], rootSessionId: string): void {
  const foreign = live.filter((row) => row.rootSessionId !== rootSessionId);
  const holder = foreign[0];
  if (holder) {
    throw new GuardRejectedError(
      ROOT_SESSION_GUARD,
      `Item ${holder.itemId} is already held by another crew ` +
        `(root session ${holder.rootSessionId}, held as ${holder.role} by ${holder.sessionId}). ` +
        `Take it over through supersession rather than claiming alongside it.`,
      {
        fields: ["rootSessionId"],
        details: {
          heldByRootSessions: [...new Set(foreign.map((row) => row.rootSessionId))],
        },
      },
    );
  }
}

/**
 * Rejects a `role`/`roleCustom` pairing that contradicts itself.
 *
 * Both directions are refused, not just the missing one. `role = custom`
 * with no name is the obvious error; a name supplied alongside a real role
 * is the quieter one, and refusing it is what stops `roleCustom` becoming a
 * second, shadow role field that some readers consult and others don't.
 */
export function assertRoleCustom(role: Role, roleCustom: string | null | undefined): void {
  if (role === "custom" && !roleCustom?.trim()) {
    throw new GuardRejectedError(
      CUSTOM_ROLE_GUARD,
      "A claim with role `custom` must say what the custom role is.",
      { fields: ["roleCustom"] },
    );
  }
  if (role !== "custom" && roleCustom != null) {
    throw new GuardRejectedError(
      CUSTOM_ROLE_GUARD,
      `roleCustom is only meaningful when role is \`custom\` (got role \`${role}\`).`,
      { fields: ["roleCustom"] },
    );
  }
}

/**
 * Claims an item, atomically.
 *
 * The write is one statement. There is no preceding "is anyone holding
 * this" query for rules 1 and 2, and adding one would not make the claim
 * safer — it would only make the failure rarer, and therefore harder to
 * find. Two concurrent callers both reach the `INSERT`; Postgres serialises
 * them on the partial unique index; exactly one gets a row back.
 *
 * Losing the race is a refusal, not a silent no-op — unlike `ensureArea`,
 * where the loser still wants the winner's row. Here, losing means somebody
 * else is driving the item, and a claim that quietly resolved to another
 * session's assignment would hand back an ownership record the caller does
 * not own.
 */
export async function claimItem(db: TransactionHandle, input: ClaimInput): Promise<Assignment> {
  assertRoleCustom(input.role, input.roleCustom);

  // A root session points at itself, so an omitted root means this claim is
  // the root of its own tree. Resolved once, here, and used for both the
  // crew check and the row — otherwise the check and the write could
  // disagree about which crew this claim belongs to.
  const rootSessionId = input.rootSessionId ?? input.sessionId;

  assertSameCrew(await liveAssignments(db, input.itemId), rootSessionId);

  // Untargeted `ON CONFLICT DO NOTHING`: it conflicts on *any* unique index
  // on the table, which is what makes one statement cover both partial
  // indexes. Naming a conflict target would cover one index and let the
  // other raise, aborting the transaction (see the module header).
  const inserted = await db.$queryRawUnsafe<Assignment[]>(
    `INSERT INTO "Assignment" (
       "id", "itemId", "role", "roleCustom", "holderType", "holderId",
       "sessionId", "parentSessionId", "rootSessionId", "machine",
       "pid", "branch", "worktree", "model", "effort"
     )
     VALUES (
       gen_random_uuid(), $1, $2::"Role", $3, $4::"HolderType", $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14
     )
     ON CONFLICT DO NOTHING
     RETURNING *`,
    input.itemId,
    input.role,
    input.roleCustom ?? null,
    input.holderType,
    input.holderId,
    input.sessionId,
    input.parentSessionId ?? null,
    rootSessionId,
    input.machine,
    input.pid ?? null,
    input.branch ?? null,
    input.worktree ?? null,
    input.model ?? null,
    input.effort ?? null,
  );

  const assignment = inserted[0];
  if (!assignment) {
    // Lost the race, or the item was already held. The transaction is
    // still alive precisely because the conflict was absorbed rather than
    // raised, so the refusal can name who won.
    throw await describeConflict(db, input, rootSessionId);
  }

  await appendEvent(db, {
    itemId: assignment.itemId,
    actor: {
      actorType: assignment.holderType,
      actorId: assignment.holderId,
      sessionId: assignment.sessionId,
    },
    assignmentId: assignment.id,
    type: "claim",
    payload: {
      role: assignment.role,
      ...(assignment.roleCustom === null ? {} : { roleCustom: assignment.roleCustom }),
      rootSessionId: assignment.rootSessionId,
      machine: assignment.machine,
    },
  });

  return assignment;
}

/**
 * Works out which rule refused the claim, and names the holder.
 *
 * Reads the live rows *after* the conflict, inside the same transaction, so
 * it describes the state the insert actually lost to rather than a snapshot
 * taken before it. Returns the error rather than throwing it, so the call
 * site reads as the `throw` it is.
 *
 * The order matters: a session claiming a second row on an item it already
 * holds is reported as the session conflict even if it also asked to be
 * orchestrator, because that is the more specific and more actionable
 * answer — "you already hold this item" tells the caller what to do, where
 * "someone is orchestrating" would send it looking for another session.
 */
async function describeConflict(
  db: TransactionHandle,
  input: ClaimInput,
  rootSessionId: string,
): Promise<ConflictError> {
  const live = await liveAssignments(db, input.itemId);

  const ownRow = live.find((row) => row.sessionId === input.sessionId);
  if (ownRow) {
    return new ConflictError(
      `Session ${input.sessionId} already holds a live assignment on ${input.itemId} ` +
        `(as ${ownRow.role}). One session holds at most one row per item.`,
      {
        fields: ["itemId", "sessionId"],
        details: { rule: "one_row_per_session_per_item", assignmentId: ownRow.id },
      },
    );
  }

  const orchestrator = live.find((row) => row.role === "orchestrator");
  if (input.role === "orchestrator" && orchestrator) {
    return new ConflictError(
      `Session ${orchestrator.sessionId} is already the orchestrator on ${input.itemId}. ` +
        `Take it over through supersession rather than claiming alongside it.`,
      {
        fields: ["itemId", "role"],
        details: {
          rule: "one_live_orchestrator_per_item",
          heldBy: orchestrator.sessionId,
          assignmentId: orchestrator.id,
        },
      },
    );
  }

  // A conflict on neither partial index. Reported as a conflict rather than
  // guessed at: the insert demonstrably lost to *something* unique on this
  // table, and mislabelling it as one of the two rules above would send the
  // caller to fix the wrong thing.
  return new ConflictError(`The claim on ${input.itemId} conflicted with an existing row.`, {
    fields: ["itemId"],
    details: { rule: "unrecognised", rootSessionId, liveAssignments: live.length },
  });
}
