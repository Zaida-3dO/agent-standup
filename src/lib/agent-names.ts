// Crew naming (SCHEMA.md §9, MILESTONES.md #34) — hand out a name, assign
// it, retire it.
//
// **Why this cannot reuse `Assignment`'s "no `in_use` flag" liveness.**
// SCHEMA.md §9 says a name's use is derived from whether any `Assignment`
// holds it with `releasedAt IS NULL` — but `Assignment.itemId` is required
// (schema.prisma), so an `Assignment` row cannot exist before an item does.
// A session asking for a crew name typically does so at spawn, before it has
// claimed anything. So this module tracks a narrower, earlier concept — a
// **hold** — on two columns added directly to `Agent`: `heldBySessionId` and
// `heldAt`. A name is in use, for the purposes of this module, exactly when
// `heldBySessionId IS NOT NULL`. Once a held session goes on to claim real
// work, `claimItem` (claims.ts) records that session as the assignment's
// `holderId` independently — the two mechanisms describe the same session by
// the same string but neither reads the other's storage.
//
// **The concurrency shape, and why it is not `claims.ts`'s shape.**
// `claimItem` and `ensureArea` both resolve their race with
// `INSERT ... ON CONFLICT DO NOTHING`, because in both cases the row being
// raced for is *identified in the statement* — a specific item, a specific
// normalised area id. Handing out a name is different: the caller does not
// name a row, it asks for *any one* row satisfying "not retired, not held".
// That is not a uniqueness conflict — nothing about a fresh row violates a
// constraint on its own, so `INSERT ... ON CONFLICT` has nothing to catch.
// The Postgres-native answer to "give me one available row, and only one,
// under concurrency" is `UPDATE ... WHERE name = (SELECT ... FOR UPDATE
// SKIP LOCKED LIMIT 1)`: the subselect takes a row lock before the update
// commits to it, `SKIP LOCKED` means a second, concurrent caller's subselect
// skips whatever the first caller already locked rather than blocking on it
// or double-picking it, and the whole statement is one round trip — there is
// no separate "read the candidate, then write it" for a race to land inside.
// This is the same family of guarantee as `ON CONFLICT DO NOTHING`: Postgres
// serialises it, not application code.
import { ConflictError, NotFoundError } from "./service/errors";

/** The subset of a Prisma-like client this module needs. */
export interface AgentNameClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface AgentNameRow {
  readonly name: string;
  readonly roleHint: string | null;
  readonly persona: string | null;
  readonly retiredAt: Date | null;
  readonly heldBySessionId: string | null;
  readonly heldAt: Date | null;
}

const AGENT_COLUMNS = `"name", "roleHint", "persona", "retiredAt", "heldBySessionId", "heldAt"`;

/**
 * Hands out one available name to `sessionId`, atomically.
 *
 * "Available" means not retired and not held by any session.
 * Among the rows that qualify, the lock-and-pick order is `name` ascending —
 * arbitrary but deterministic, which is what makes a test able to assert
 * anything about *which* name comes back under a controlled roster; nothing
 * in this module's contract promises a caller a *particular* name, only
 * *an* available one.
 *
 * Returns `undefined` when the roster is exhausted (every name is either
 * retired or already held) rather than throwing — an empty pool is an
 * ordinary operational state (SCHEMA.md's `minting.backlog_low_threshold`
 * is the same shape of signal for a different pool), not a caller error.
 */
export async function handOutName(
  client: AgentNameClient,
  sessionId: string,
): Promise<AgentNameRow | undefined> {
  const rows = await client.$queryRawUnsafe<AgentNameRow[]>(
    `UPDATE "Agent"
       SET "heldBySessionId" = $1, "heldAt" = CURRENT_TIMESTAMP
       WHERE "name" = (
         SELECT "name" FROM "Agent"
         WHERE "retiredAt" IS NULL AND "heldBySessionId" IS NULL
         ORDER BY "name" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${AGENT_COLUMNS}`,
    sessionId,
  );
  return rows[0];
}

/**
 * The name `sessionId` holds, or `undefined` if it holds none.
 *
 * The lookup a caller assigning names server-side needs before reaching for
 * `handOutName`: a session that registers twice, or that claims a second
 * item, must **keep** the name it already has rather than drawing a second
 * one from the pool — that would leave its first name permanently held and
 * orphaned (nothing ever releases it) and give one session two identities in
 * the same history. Read-only and outside any lock, which is fine for its
 * one caller's purpose: the write that follows (`handOutName`) is itself
 * atomic, so a stale read here costs nothing worse than a wasted hand-out
 * check, never a double allocation.
 */
export async function nameHeldBy(
  client: AgentNameClient,
  sessionId: string,
): Promise<AgentNameRow | undefined> {
  const rows = await client.$queryRawUnsafe<AgentNameRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM "Agent" WHERE "heldBySessionId" = $1 LIMIT 1`,
    sessionId,
  );
  return rows[0];
}

/**
 * The server-side naming path: `sessionId` is handed the name it already
 * holds, if any, otherwise one is drawn from the pool.
 *
 * This is what `register_session` and `claim` call instead of asking an
 * agent to have called `get_crew_name` first — naming stops being a decision
 * the caller makes and becomes a side effect of the calls a session was
 * already required to make. Two properties fall out of composing the two
 * primitives above rather than writing a third query:
 *
 *   - **A session keeps its name across repeat calls.** `register_session` is
 *     documented as idempotent (a reconnect re-registers), and `claim` is
 *     called once per item a crew takes on — neither should mint a second
 *     identity for a session that already has one. The `nameHeldBy` check
 *     first is what makes that true; without it, a session registering twice
 *     would hold two names, one of them permanently orphaned (nothing
 *     releases a name on a session's *second* registration).
 *   - **An exhausted pool degrades to unnamed, not to a thrown error.**
 *     `handOutName` returning `undefined` propagates here as `undefined`
 *     rather than `ConflictError` — `get_crew_name` throws because "give me a
 *     name" with nothing to give is the caller's whole request failing, but
 *     naming here is a courtesy riding on a call the session needed to make
 *     for an unrelated reason (registering, claiming). Failing *that* call
 *     because the name pool ran dry would make an operational shortage of
 *     one resource block work on a completely different one.
 *
 * Not wrapped in its own transaction: both queries already run inside
 * whichever transaction the calling operation opened (`ServiceContext.db`),
 * so the read-then-maybe-write is atomic with everything else that
 * operation does, the same as any other multi-statement operation body here.
 */
export async function ensureNameForSession(
  client: AgentNameClient,
  sessionId: string,
): Promise<AgentNameRow | undefined> {
  const held = await nameHeldBy(client, sessionId);
  if (held) return held;
  return handOutName(client, sessionId);
}

/**
 * Assigns one *specific* name to `sessionId` — the deliberate-choice path,
 * as opposed to `handOutName`'s "any available one". Used where a caller
 * names the agent itself rather than drawing from the pool (an operator
 * pinning a name, a re-seed).
 *
 * Same atomicity property as `handOutName`, narrowed to a single target row
 * instead of a subselect: the `UPDATE ... WHERE` guards retired-ness and
 * held-ness in the same statement that claims the hold, so two concurrent
 * callers targeting the same name can never both succeed — exactly the
 * "push the race into Postgres" reasoning `claims.ts` and `areas.ts` state,
 * applied to a single-row `UPDATE` instead of an `INSERT`.
 *
 * Throws `NotFoundError` for a name the registry does not know, and
 * `ConflictError` — naming which rule and, where knowable, who holds it —
 * for a name that exists but is retired or already held. Both are read
 * *after* the failed update, inside the same call, the same way
 * `claims.ts`'s `describeConflict` disambiguates a lost race without
 * needing the aborted-transaction workaround claims.ts documents: this
 * statement has no unique-index violation to raise in the first place, an
 * `UPDATE` that matches no row simply returns zero rows.
 */
export async function assignName(
  client: AgentNameClient,
  name: string,
  sessionId: string,
): Promise<AgentNameRow> {
  const rows = await client.$queryRawUnsafe<AgentNameRow[]>(
    `UPDATE "Agent"
       SET "heldBySessionId" = $2, "heldAt" = CURRENT_TIMESTAMP
       WHERE "name" = $1 AND "retiredAt" IS NULL AND "heldBySessionId" IS NULL
       RETURNING ${AGENT_COLUMNS}`,
    name,
    sessionId,
  );
  const updated = rows[0];
  if (updated) {
    return updated;
  }

  const existing = await client.$queryRawUnsafe<AgentNameRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM "Agent" WHERE "name" = $1`,
    name,
  );
  const current = existing[0];
  if (!current) {
    throw new NotFoundError(`No such agent name: ${name}.`, { fields: ["name"] });
  }
  if (current.retiredAt !== null) {
    throw new ConflictError(`Agent name ${name} is retired and cannot be assigned.`, {
      fields: ["name"],
      details: { rule: "name_retired", retiredAt: current.retiredAt },
    });
  }
  // Not retired, so the only other reason the UPDATE could have matched
  // zero rows is that it is already held — including by the very race this
  // function is meant to lose gracefully to.
  throw new ConflictError(`Agent name ${name} is already held.`, {
    fields: ["name"],
    details: { rule: "name_already_held", heldBySessionId: current.heldBySessionId },
  });
}

/**
 * Releases `sessionId`'s hold on `name`, clearing both columns together.
 *
 * Scoped to the *holding* session, not just the name: a release naming the
 * wrong session is refused rather than silently freeing someone else's
 * name, the same asymmetry `claims.ts` draws between "your own row" and
 * "any row". Releasing a name that was never held, or is held by a
 * different session, is a no-op that returns `undefined` rather than an
 * error — a caller racing its own shutdown against a takeover is the
 * ordinary case, not a bug to report loudly.
 */
export async function releaseName(
  client: AgentNameClient,
  name: string,
  sessionId: string,
): Promise<AgentNameRow | undefined> {
  const rows = await client.$queryRawUnsafe<AgentNameRow[]>(
    `UPDATE "Agent"
       SET "heldBySessionId" = NULL, "heldAt" = NULL
       WHERE "name" = $1 AND "heldBySessionId" = $2
       RETURNING ${AGENT_COLUMNS}`,
    name,
    sessionId,
  );
  return rows[0];
}

/**
 * Why `handOutName` came back empty — the two situations it cannot tell
 * apart on its own, separated by one `COUNT(*)`.
 *
 * `empty_roster` means no usable name exists: the seed has not run, or every
 * name has been retired, and either way the fix is to load some names.
 * `all_held` means usable names exist and every one of them is taken, and
 * the fix is to wait, or to look at why names are not coming back. Those are
 * different problems with different remedies, and a single "no name is
 * available" sends both readers looking in the wrong place — the one with
 * an unseeded installation goes hunting for a leak that is not there, and
 * the one with a genuine shortage reseeds a roster that is already full.
 *
 * The discriminator is deliberately "is there a usable name", not "is the
 * table non-empty". A roster of nothing but retired names has nothing to
 * hand out and nobody holding anything, so reporting it as a shortage would
 * send an operator looking for holders that do not exist.
 *
 * Counted rather than inferred, and only on the failure path: the
 * successful hand-out stays exactly one statement, which is what keeps this
 * diagnosis free in the case that actually runs. Retired names are excluded
 * because a roster of nothing but retired names is not a populated one for
 * any purpose a caller has.
 */
export type NameShortage = "empty_roster" | "all_held";

export async function diagnoseNameShortage(client: AgentNameClient): Promise<NameShortage> {
  const rows = await client.$queryRawUnsafe<{ usable: bigint }[]>(
    `SELECT COUNT(*)::bigint AS "usable" FROM "Agent" WHERE "retiredAt" IS NULL`,
  );
  // A missing row would mean the count did not run. Report `all_held`: it is
  // the conservative answer, since it sends the reader to look at holds
  // rather than telling them to seed a roster that may be perfectly fine.
  const usable = rows[0]?.usable;
  if (usable === undefined) return "all_held";
  return usable === 0n ? "empty_roster" : "all_held";
}

/**
 * Returns `sessionId`'s crew name to the pool, but only once that session
 * holds no live claim anywhere.
 *
 * **Why the pool needs this at all.** A name is drawn as a side effect of
 * `register_session` and `claim` and the hold is stored on `Agent`, so
 * without a path that clears it the roster is a consumable: every session
 * that ever registers takes one name permanently, and a long-running
 * installation exhausts the pool with names held by sessions that ended
 * weeks ago. Nothing else clears `heldBySessionId`.
 *
 * **Why it is keyed on the session's *last* claim rather than on any
 * release.** The hold belongs to the session, not to one assignment — a
 * session may hold several items at once, and `ensureNameForSession` is
 * deliberately idempotent so that all of them are narrated under one
 * identity. Freeing the name when any single claim ends would hand that
 * identity to another session while the first is still working under it,
 * and the board would then show two different crews wearing one name in the
 * same history. So the count has to reach zero first.
 *
 * **Why the count is read in the same transaction as the release that
 * prompted it.** The caller has just set `releasedAt` on the row it is
 * giving up; this counts what remains. Both statements are inside the
 * operation's transaction, so no concurrent claim can slip between them and
 * be missed — a claim that commits first is counted, and one that commits
 * after has taken a name of its own through `ensureNameForSession`.
 *
 * Returns the freed row, or `undefined` when the session still holds work,
 * holds no name, or its name was already returned. Every one of those is an
 * ordinary outcome rather than an error: this runs as a courtesy on the way
 * out of a release, and a release must not fail because the pool
 * bookkeeping had nothing to do.
 */
export async function releaseNameIfSessionIdle(
  client: AgentNameClient,
  sessionId: string,
): Promise<AgentNameRow | undefined> {
  const held = await nameHeldBy(client, sessionId);
  if (!held) return undefined;

  const live = await client.$queryRawUnsafe<{ liveCount: bigint }[]>(
    `SELECT COUNT(*)::bigint AS "liveCount"
       FROM "Assignment"
      WHERE "sessionId" = $1 AND "releasedAt" IS NULL`,
    sessionId,
  );
  // `COUNT(*)` always returns exactly one row, so a missing row would mean
  // the query did not run at all; treat that as "still busy" and keep the
  // name rather than freeing one on an answer we did not get.
  const liveCount = live[0]?.liveCount;
  if (liveCount === undefined || liveCount > 0n) return undefined;

  return releaseName(client, held.name, sessionId);
}

/**
 * Retires a name permanently. Does **not** clear an existing hold —
 * "names appear throughout history" (SCHEMA.md §9), so a name retired while
 * still held by a live session keeps recording who held it rather than
 * quietly erasing that fact; the session's own release path clears the hold
 * as normal, and either order is safe: retiring first still blocks a later
 * `handOutName`/`assignName` from ever reissuing the name, retired or not.
 *
 * Idempotent by intent, not by accident: retiring an already-retired name
 * is refused with `ConflictError` rather than silently succeeding a second
 * time, because a caller retiring the same name twice is more likely to be
 * confused about which name it means than deliberately re-confirming — the
 * same posture `describeConflict` in claims.ts takes toward "tell the truth
 * about the state, don't paper over it".
 */
export async function retireName(client: AgentNameClient, name: string): Promise<AgentNameRow> {
  const rows = await client.$queryRawUnsafe<AgentNameRow[]>(
    `UPDATE "Agent"
       SET "retiredAt" = CURRENT_TIMESTAMP
       WHERE "name" = $1 AND "retiredAt" IS NULL
       RETURNING ${AGENT_COLUMNS}`,
    name,
  );
  const updated = rows[0];
  if (updated) {
    return updated;
  }

  const existing = await client.$queryRawUnsafe<AgentNameRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM "Agent" WHERE "name" = $1`,
    name,
  );
  const current = existing[0];
  if (!current) {
    throw new NotFoundError(`No such agent name: ${name}.`, { fields: ["name"] });
  }
  throw new ConflictError(`Agent name ${name} is already retired.`, {
    fields: ["name"],
    details: { rule: "already_retired", retiredAt: current.retiredAt },
  });
}

/** All non-retired names, held or not — for admin listing. */
export async function listActiveNames(client: AgentNameClient): Promise<AgentNameRow[]> {
  return client.$queryRawUnsafe<AgentNameRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM "Agent" WHERE "retiredAt" IS NULL ORDER BY "name" ASC`,
  );
}
