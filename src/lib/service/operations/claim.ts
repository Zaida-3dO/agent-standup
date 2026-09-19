// `claim` — SCHEMA.md §2, §18, §19. Takes ownership of an item in a role,
// atomically.
//
// This operation is a thin wrapper around `claimItem` (src/lib/claims.ts,
// MILESTONES.md #23) — the atomic INSERT-with-partial-unique-index logic
// and the root-session/role guards already live there and are not
// duplicated here. What this row adds is the *service operation*: input
// validation against a schema every adapter shares, an explicit item-
// existence check (the FK on `Assignment.itemId` would otherwise surface as
// a raw constraint violation rather than a typed `not_found`), and
// registration so every adapter (HTTP now, MCP and the command line later)
// reaches the same atomic write through the same door.
import { z } from "zod";
import { ConflictError, GuardRejectedError, InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ROOT_SESSION_GUARD,
  claimItem,
  type Assignment,
  type HolderType,
  type Role,
} from "@/lib/claims";
import { assertSessionMayClaim } from "../session-registration";
import { ensureNameForSession } from "@/lib/agent-names";
import { evictStaleHolders, type EvictedClaim } from "@/lib/claim-eviction";
import { resolveItemId } from "../items/resolve-id";
import { resolveLease, type ResolvedLease } from "@/lib/lease-resolution";

const ROLES = [
  "orchestrator",
  "builder",
  "reviewer",
  "visual_reviewer",
  "scout",
  "custom",
] as const;
const HOLDER_TYPES = ["person", "agent"] as const;

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    role: z.enum(ROLES),
    /** Required iff `role === "custom"` — enforced by `assertRoleCustom` inside `claimItem`. */
    roleCustom: z.string().min(1).nullable().optional(),
    /**
     * **The one field carrying who is claiming** — `rootSessionId`,
     * `sessionId`, `holderType` and `holderId`, all implicit in it
     * (src/lib/lease-key.ts). Issued by `session {action: "register"}` and
     * returned on every claim response.
     *
     * Optional *in the schema* only because the legacy fields are still
     * accepted during the deprecation window. A call carrying neither this
     * nor `sessionId` + `holderType` + `holderId` is refused by
     * `resolveLease` — see the contract rule below. That refusal is the
     * point of the field: an absent identity used to default to "I am my
     * own crew", which for a dispatched agent was always wrong and never
     * visible.
     */
    leaseKey: z.string().min(1).nullable().optional(),
    /**
     * Deprecated in favour of `leaseKey`, which carries it. Still accepted,
     * and still required when no key is passed.
     */
    holderType: z.enum(HOLDER_TYPES).optional(),
    /** Deprecated in favour of `leaseKey`, which carries it. */
    holderId: z.string().min(1).optional(),
    /** Deprecated in favour of `leaseKey`, which carries it. */
    sessionId: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).nullable().optional(),
    /**
     * Deprecated in favour of `leaseKey`, which carries it.
     *
     * Omitting it alongside the other legacy fields still means "this
     * session is the root of its own crew" (SCHEMA.md §2) — unchanged, so
     * an existing orchestrator keeps working — but the response now says
     * so out loud, because that default is the thing a dispatched agent
     * must not silently get.
     */
    rootSessionId: z.string().min(1).nullable().optional(),
    /**
     * The machine this claim runs on.
     *
     * Optional since MILESTONES.md #111: a session states its machine once,
     * at registration, and `Session.machine` holds it — so a claim from a
     * registered session inherits it rather than restating a constant on
     * every call. Naming it explicitly still wins, and it stays required in
     * substance for an *unregistered* session, which has no row to inherit
     * from: that call is refused by name rather than storing a guess.
     */
    machine: z.string().min(1).optional(),
    pid: z.number().int().nullable().optional(),
    branch: z.string().min(1).nullable().optional(),
    worktree: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
  })
  .strict();

export type ClaimOperationInput = z.infer<typeof inputSchema>;

/**
 * `claim`'s result: the assignment, plus the crew name the claiming session
 * is now known by.
 *
 * `crewName` is `null` for a `holderType: "person"` claim — a person is
 * named by `holderId` already, and drawing from the agent-name pool for a
 * human holder would spend a name on nobody who uses it — and also `null`
 * when the pool is exhausted (see `ensureNameForSession`). It is included on
 * every claim response, not only a crew's first, so **the parent orchestrator
 * spawning a subagent learns that subagent's friendly name from the same
 * call it already makes to record the claim**, rather than needing a second
 * round trip to ask for one.
 */
export interface ClaimResult extends Assignment {
  readonly crewName: string | null;
  /**
   * Claims this call reclaimed from holders judged gone, before winning.
   * Empty on the ordinary path.
   *
   * Returned rather than left to the event ledger because the caller is the
   * one party in a position to notice the eviction was wrong — it knows
   * which agent it is and can say "that was my own other session". A silent
   * reclaim would put that discovery arbitrarily far from the act.
   */
  readonly evicted: readonly EvictedClaim[];
  /**
   * Said when `rootSessionId` names a session this server has never seen —
   * and `null` on every other path, including the ordinary one.
   *
   * ── Why this is a warning and not a refusal ─────────────────────────────
   *
   * `rootSessionId` is the whole of crew-conflict protection: `assertSameCrew`
   * compares it against the item's live assignments, and a value matching
   * nothing matches nothing *safely* — the claim succeeds and the guard has
   * no other crew to find. One mistyped character therefore buys a run with
   * the protection silently absent, which is the failure this field exists
   * to make audible: **not a refusal, a silent wrong result.**
   *
   * Refusing would be the wrong fix. A root session that has legitimately
   * ended is still the correct crew id for its subagents to carry — the tree
   * outlives the root — and there is no way to tell that case from a typo
   * from here. So the call succeeds, exactly as before, and says what it
   * could not confirm. Nothing downstream branches on this string; removing
   * it changes no behaviour, only what the caller is told.
   *
   * Put in the response rather than a document about the response, for the
   * same reason `describe_tool`'s rules are: the caller is already looking
   * here.
   */
  readonly rootSessionWarning: string | null;
  /**
   * The lease key for this claim — **the thing to pass on the next one**,
   * and the thing to hand to any agent this session dispatches.
   *
   * Returned on every claim, not only a first one, for the same reason
   * `crewName` is: the call a caller already makes is the cheapest possible
   * place to learn the value the next call needs, and a second round trip
   * to fetch it is a round trip that some callers will simply not make.
   */
  readonly leaseKey: string;
  /**
   * Said when this claim used the deprecated identity fields — `null` when
   * it passed a `leaseKey`.
   *
   * A deprecation belongs in the response rather than in a document: a
   * caller using the deprecated shape is told, at the moment it uses it,
   * which field supersedes it and that this very response already carries
   * the value to switch to.
   */
  readonly leaseKeyDeprecation: string | null;
}

/**
 * The machine to record on a claim: the one the call names, else the one
 * the session registered with (MILESTONES.md #111).
 *
 * ── Why the session row rather than `ctx.caller.machine` ───────────────
 *
 * The proved machine would be the stronger source, and `register_session`
 * now prefers it (`../machine-identity.ts`). It is deliberately *not* used
 * here, because a claim's machine answers a different question than a
 * request's does: `Assignment.machine` records where the claimed work is
 * running, and an orchestrator on one machine may legitimately record a
 * claim for a subagent it spawned — the transport would prove the
 * orchestrator's machine and be wrong about the work. The session row is
 * the right fallback because it is that session's own declaration of where
 * it runs, which is exactly what the claim is asserting.
 *
 * ── Why an unregistered session is refused rather than defaulted ────────
 *
 * `Assignment.machine` is a non-null column and there is no honest value
 * to invent for a session that never said. A placeholder would put a lie in
 * the fleet view — a claim listed as running somewhere it is not — and the
 * fleet view exists to answer "where is this work". So the refusal names
 * both routes out, since either genuinely fixes it.
 */
async function resolveClaimMachine(
  ctx: ServiceContext,
  input: ClaimOperationInput,
  sessionId: string,
): Promise<string> {
  if (input.machine !== undefined) return input.machine;

  const rows = await ctx.db.$queryRawUnsafe<{ machine: string }[]>(
    `SELECT "machine" FROM "Session" WHERE "id" = $1`,
    sessionId,
  );
  const machine = rows[0]?.machine;
  if (machine === undefined) {
    throw new InvalidInputError(
      `This claim omitted \`machine\` and session ${sessionId} has not ` +
        `registered, so there is no declared machine to inherit. Either register the ` +
        `session (\`session\` with action register), which is how a machine is stated ` +
        `once and reused, or pass \`machine\` on this call.`,
      { fields: ["machine"] },
    );
  }
  return machine;
}

/**
 * The warning for a `rootSessionId` naming no session this server knows, or
 * `null` when there is nothing to say.
 *
 * Three cases, and only one of them warns:
 *
 * - **Field absent** — not a typo, a declaration. An omitted `rootSessionId`
 *   means "this session is the root of its own crew" (SCHEMA.md §2), which is
 *   the single most common claim there is. Warning here would fire on the
 *   majority of calls and train every caller to stop reading the field, which
 *   costs exactly the attention it exists to buy on the calls that matter —
 *   the same reasoning `buildSliceNotice` uses to return null rather than
 *   announce that it withheld nothing.
 * - **Names a known session** — the ordinary crew case. Silent.
 * - **Names a session with no row** — warned, and the call proceeds.
 *
 * A value equal to the caller's own `sessionId` is deliberately NOT special-
 * cased: a session that names itself as its own root but never registered is
 * in exactly the position this warning describes, and it is checked by the
 * same read as every other value.
 */
async function rootSessionWarningFor(
  ctx: ServiceContext,
  lease: ResolvedLease,
): Promise<string | null> {
  // Only a root the caller actually STATED is worth warning about. On the
  // legacy path with `rootSessionId` omitted, the root was defaulted to the
  // caller's own session and warning about it would be warning about our
  // own arithmetic — the deprecation sentence already covers that case, and
  // says the more useful thing. A key always states its root explicitly, so
  // a key-borne root is always checked.
  const rootSessionId =
    lease.source === "legacy" ? lease.statedRootSessionId : lease.identity.rootSessionId;
  if (rootSessionId === undefined || rootSessionId === null) return null;

  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Session" WHERE "id" = $1`,
    rootSessionId,
  );
  if (rows.length > 0) return null;

  return (
    `Claimed, but \`rootSessionId\` ${rootSessionId} names no session this server has seen, ` +
    `so crew-conflict protection will not apply to this claim: the one-crew-per-item guard ` +
    `compares root sessions, and a root nothing else shares can never collide with another ` +
    `crew. If that id is a typo, release this claim and re-claim with the right one — ` +
    `most often the orchestrator's own \`sessionId\`, which a dispatched agent must pass ` +
    `explicitly. If the root session genuinely ended, this is expected and nothing is wrong.`
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const claim = defineOperation({
  name: "claim",
  kind: "write",
  summary: "Takes ownership of an item in a role. Atomic — two agents can't both win.",
  contract: {
    rules: [
      {
        fields: ["leaseKey"],
        rule: "IDENTITY IS ONE FIELD NOW. `leaseKey` carries `rootSessionId`, `sessionId`, `holderType` and `holderId` together, and a claim stating NEITHER a `leaseKey` nor that set of legacy fields is REFUSED rather than defaulted. Get a key from `session` with action register, or from any claim response — if you were dispatched, ask the agent that dispatched you for its key, exactly as you would once have asked for its `rootSessionId`.",
      },
      {
        fields: ["rootSessionId", "sessionId", "holderType", "holderId"],
        rule: "THE LEGACY IDENTITY FIELDS STILL WORK, AND ARE DEPRECATED. Passing `sessionId`, `holderType`, `holderId` and optionally `rootSessionId` claims exactly as it always did, and the response carries both a `leaseKey` to use next time and a `leaseKeyDeprecation` sentence. Omitting `rootSessionId` on that path still defaults it to your own `sessionId`, which declares you the root of your own crew — right for an orchestrator, wrong for a dispatched agent, and the reason the key exists. Passing BOTH a key and legacy fields is accepted only while they agree, and refused naming every field that disagrees.",
      },
      {
        fields: ["leaseKey"],
        rule: "ONE CREW PER ITEM. A claim is refused when the item's live assignments carry a different crew root than this one — the root inside your `leaseKey`, or your `rootSessionId` on the legacy path. Pass the key of the crew you belong to, not one you minted yourself, whenever somebody else already holds the item.",
      },
      {
        fields: ["rootSessionId"],
        rule: "A `rootSessionId` NAMING NO KNOWN SESSION IS NOT REFUSED — it warns. The claim succeeds and the response carries `rootSessionWarning` saying the id matched no session, because a root that has legitimately ended is still the right id for its subagents to carry and refusing it would break that workflow to catch a typo. Read the field: a mistyped id silently costs you crew-conflict protection for the whole run, since a root nothing else shares can never collide with another crew.",
      },
      {
        fields: ["itemId", "sessionId"],
        // ── Word order here is load-bearing, not style ──────────────────
        //
        // `attributeTo` (`../describe/advice.ts`) binds a mentioned field
        // to the LAST operation named before it in the text, which is how
        // the prose reads. So the `claim` again clause has to come BEFORE
        // the `force`/`reason` sentence: with the order reversed, the
        // trailing mention of `claim` re-attributes `force` and `reason` to
        // `claim`, which has no such keys, and `findAdviceDefects` reports
        // a `parameter` defect that fails the build. That is the very
        // defect class this rule was added to fix, so getting it wrong here
        // would be the joke writing itself.
        rule: 'TAKING A HELD ITEM OVER. When `claims.one_crew_per_item` refuses this, the item belongs to another crew and no amount of re-trying will win it — supersede the holder with `ownership {action: "takeover", itemId, fromSessionId: <the holder\'s sessionId>, bySessionId: <yours>, holderType, holderId}`. That action frees the holder\'s assignment but does NOT assign the item to you, so run `ownership` with `action: "claim"` again afterwards to actually take it. When the holder is still live — liveness `running` or `stalled` rather than `dead` — the takeover action additionally requires `force: true` and a written `reason`, because taking work from a session that may still be doing it is a decision somebody has to own in the record.',
      },
      {
        fields: ["sessionId", "itemId"],
        rule: 'ONE LIVE ROW PER SESSION PER ITEM. A session that already holds a live assignment on this item cannot take a second one — change roles by giving up the first, with `ownership` and `action: "release"`. Enforced by a partial unique index rather than a pre-read, so it is decided by the database and refuses with `conflict` naming the row you already hold.',
      },
      {
        fields: ["role", "itemId"],
        rule: 'ONE LIVE ORCHESTRATOR PER ITEM. A second `role: "orchestrator"` claim is refused while the first is live; any number of builders, reviewers and scouts may hold the item alongside it. Also enforced by a partial unique index.',
      },
      {
        fields: ["roleCustom", "role"],
        rule: "`roleCustom` is required when `role` is `custom` and refused when it is not. Both directions are checked, so a name supplied beside a real role is an error rather than being ignored — that is what stops `roleCustom` becoming a shadow role field some readers consult.",
      },
      {
        fields: ["machine", "sessionId"],
        rule: "`machine` is optional only for a session that has already registered: it is inherited from `Session.machine`. An UNREGISTERED session omitting it is refused by name rather than having a machine guessed for it — either register the session first with `session` action register, or pass `machine` on this call.",
      },
    ],
    example: {
      itemId: "b1f0c3d2-0000-4000-8000-000000000000",
      role: "builder",
      holderType: "agent",
      holderId: "poe-3f1",
      sessionId: "725c8167",
      rootSessionId: "cd1575a9",
      machine: "laptop",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ClaimOperationInput): Promise<ClaimResult> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      itemId: await resolveItemId(ctx.db, input.itemId, "itemId"),
    };

    // Checked explicitly, ahead of the insert: `Assignment.itemId` carries a
    // foreign key, so claiming a non-existent item would otherwise surface
    // as a raw Postgres constraint violation (mapped to `InternalError` by
    // `toServiceError`) rather than the typed `not_found` every other
    // operation returns for a bad id.
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    // §21: no unguarded session holds work, where the setting enforcing it is
    // on. Checked *before* the insert, not after — a claim that is going to
    // be refused must not first win the atomic race and displace whoever
    // would otherwise have got it, because the partial unique index makes
    // that win visible to every other claimant for as long as the
    // transaction is open.
    //
    // Checked after the item-existence read on purpose, so a claim naming a
    // typo'd item id is told about the typo rather than about its
    // registration: the caller can act on the first and, in that moment,
    // cannot act on the second.
    // Who is claiming, from the lease key or the deprecated fields — and a
    // refusal when the call states neither. Resolved BEFORE the
    // registration check so a call carrying no identity at all is told
    // that, rather than being told that `undefined` has not registered.
    const lease = resolveLease(input);
    const { sessionId, holderType, holderId, rootSessionId } = lease.identity;

    await assertSessionMayClaim(ctx, sessionId);

    // The machine, from the claim or from what the session registered with
    // (#111). Read after `assertSessionMayClaim` so a claim that is going
    // to be refused for its registration is told *that*, rather than being
    // told its machine is unresolvable — which is the same fact stated less
    // usefully, since registering fixes both.
    const machine = await resolveClaimMachine(ctx, input, sessionId);

    const claimInput = {
      itemId: input.itemId,
      role: input.role as Role,
      roleCustom: input.roleCustom ?? null,
      holderType: holderType as HolderType,
      holderId,
      sessionId,
      parentSessionId: input.parentSessionId ?? null,
      rootSessionId,
      leaseKey: lease.leaseKey,
      machine,
      pid: input.pid ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
    };

    // ── Lazy eviction of a stranded claim ───────────────────────────────
    //
    // Attempt first, evict only on refusal. The ordering is the design, not
    // an optimisation: an eviction pass that ran *before* every claim would
    // read and lock every live assignment on the item on the overwhelmingly
    // common path where nothing is stale, and — worse — would make the cost
    // of the rare case the cost of the normal one. A refusal is the only
    // signal that anybody is actually contending, which is precisely when
    // the staleness question is worth asking. See `src/lib/claim-eviction.ts`
    // for what counts as evidence and why the bar is set where it is.
    //
    // **Only these two refusals are retried.** A `ConflictError` means an
    // index or the one-row-per-session rule refused; a `ROOT_SESSION_GUARD`
    // rejection means another crew holds it. Both are "somebody else has
    // this", which eviction can genuinely resolve. Every other refusal —
    // a malformed `role`/`roleCustom` pairing, an unregistered session — is
    // about *this* caller and would be refused identically after any number
    // of evictions, so retrying it would release other sessions' claims to
    // no purpose. That is why the catch is narrow rather than a bare retry.
    let assignment: Assignment;
    let evicted: EvictedClaim[] = [];
    try {
      assignment = await claimItem(ctx.db, claimInput);
    } catch (error) {
      if (!isHeldByAnotherSession(error)) throw error;

      evicted = await evictStaleHolders(ctx.db, {
        itemId: input.itemId,
        evictAfterSeconds: ctx.settings.values["liveness.evict_after_seconds"],
        bySessionId: sessionId,
      });

      // Nothing was stale enough to take. Rethrow the *original* refusal
      // rather than a new one about eviction: the holder is alive as far as
      // anything here can tell, and the original error already names it and
      // says which rule refused, which is what the caller acts on.
      //
      // **Rethrowing also rolls the evictions back**, because the whole
      // operation is one transaction (`ServiceRuntime` opens it around the
      // handler). That is the conservative direction and it is relied on
      // rather than worked around: an eviction persists only when it
      // actually handed the item to somebody. A claim that was going to be
      // refused anyway — by the crew guard, say — therefore cannot leave a
      // crew one member short as a side effect of having been attempted.
      if (evicted.length === 0) throw error;

      // Exactly one retry, never a loop. The eviction pass judged every
      // live row on the item in one go, so a second failure cannot be
      // resolved by evicting again — it is a genuine conflict (a live
      // holder that survived judgement, or a concurrent claim that won the
      // freed slot), and retrying would spin.
      assignment = await claimItem(ctx.db, claimInput);
    }

    // Named on the same call that claims, not a second one (§9, §18): a
    // claim made on behalf of a subagent (`holderType: "agent"`) is exactly
    // the moment a parent orchestrator needs a human-usable name for it, so
    // the name is assigned here and handed straight back. A person claiming
    // (`holderType: "person"`) is already named by `holderId` — drawing from
    // the agent-name pool for a human holder would spend a name nobody
    // reads, so this only ever names an agent holder.
    const crewNameRow =
      holderType === "agent" ? await ensureNameForSession(ctx.db, sessionId) : undefined;

    // Read only once the claim has actually won, so a call that was going to
    // be refused is told why it was refused rather than being handed an
    // advisory about a field that never mattered. It is also the reason this
    // costs nothing on the refusal paths above, which return earlier.
    const rootSessionWarning = await rootSessionWarningFor(ctx, lease);

    return {
      ...assignment,
      crewName: crewNameRow?.name ?? null,
      evicted,
      rootSessionWarning,
      leaseKey: lease.leaseKey,
      leaseKeyDeprecation: lease.leaseKeyDeprecation,
    };
  },
});

/**
 * Whether a refused claim was refused *because somebody else holds the
 * item* — the only class of refusal an eviction could resolve.
 *
 * Matched on the error type and the guard identifier rather than on message
 * text: a message is prose that gets reworded, and a retry that turned on
 * wording would quietly stop evicting the day somebody improved a sentence.
 *
 * `ConflictError` covers both partial unique indexes, including the
 * one-row-per-session rule. That last one is worth being explicit about: a
 * session that already holds a live row on this item hits it, and the
 * eviction pass will not free it, because the holder's own timestamps are
 * as fresh as the caller's. It costs one wasted pass in a case that is
 * already an error, and excluding it would mean reading the conflict's
 * `details.rule` string, which is the message-text coupling this function
 * exists to avoid.
 */
function isHeldByAnotherSession(error: unknown): boolean {
  if (error instanceof ConflictError) return true;
  return error instanceof GuardRejectedError && error.guard === ROOT_SESSION_GUARD;
}
