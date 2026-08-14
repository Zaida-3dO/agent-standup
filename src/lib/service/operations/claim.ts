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
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { claimItem, type Assignment, type HolderType, type Role } from "@/lib/claims";
import { assertSessionMayClaim } from "../session-registration";

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

export const claim = defineOperation({
  name: "claim",
  kind: "write",
  summary: "Takes ownership of an item in a role. Atomic — two agents can't both win.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ClaimOperationInput): Promise<Assignment> {
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

    // §21: no unguarded session holds work. Checked *before* the insert, not
    // after — a claim that is going to be refused must not first win the
    // atomic race and displace whoever would otherwise have got it, because
    // the partial unique index makes that win visible to every other
    // claimant for as long as the transaction is open.
    //
    // Checked after the item-existence read on purpose, so a claim naming a
    // typo'd item id is told about the typo rather than about its
    // registration: the caller can act on the first and, in that moment,
    // cannot act on the second.
    await assertSessionMayClaim(ctx, input.sessionId);

    return claimItem(ctx.db, {
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
    });
  },
});
