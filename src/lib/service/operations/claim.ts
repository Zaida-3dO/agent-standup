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
import { ConflictError, GuardRejectedError, NotFoundError } from "../errors";
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
    holderType: z.enum(HOLDER_TYPES),
    holderId: z.string().min(1),
    sessionId: z.string().min(1),
    parentSessionId: z.string().min(1).nullable().optional(),
    /** Omitted = this session is the root of its own crew (SCHEMA.md §2). */
    rootSessionId: z.string().min(1).nullable().optional(),
    machine: z.string().min(1),
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
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ClaimOperationInput): Promise<ClaimResult> {
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
    await assertSessionMayClaim(ctx, input.sessionId);

    const claimInput = {
      itemId: input.itemId,
      role: input.role as Role,
      roleCustom: input.roleCustom ?? null,
      holderType: input.holderType as HolderType,
      holderId: input.holderId,
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId ?? null,
      rootSessionId: input.rootSessionId ?? null,
      machine: input.machine,
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
        bySessionId: input.sessionId,
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
      input.holderType === "agent"
        ? await ensureNameForSession(ctx.db, input.sessionId)
        : undefined;

    return { ...assignment, crewName: crewNameRow?.name ?? null, evicted };
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
