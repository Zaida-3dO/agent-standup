// `update_repo` — SCHEMA.md §19 `PATCH /repos/{id}`, §23.1: "Archive, never
// delete — attribution and history point at these rows." MILESTONES.md #92.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { REPO_COLUMNS, toRepoRecord, type RawRepoRow, type RepoRecord } from "../admin/repo-row";

const inputSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().trim().min(1).optional(),
    // Nullable like `host`: an explicit `null` clears it back to unknown
    // rather than the only way to change it being to another guess
    // (MILESTONES.md #124).
    defaultBranch: z.string().trim().min(1).nullable().optional(),
    host: z.string().trim().min(1).nullable().optional(),
    needsVisualReview: z.boolean().optional(),
    /** `true` archives (sets `archivedAt` to now), `false` un-archives (clears it). Omitted = no change. */
    archived: z.boolean().optional(),
  })
  .strict();

export type UpdateRepoInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const updateRepo = defineOperation({
  name: "update_repo",
  kind: "write",
  summary: "Edits a repository's fields, and archives or un-archives it.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateRepoInput): Promise<RepoRecord> {
    const { id, archived, ...edits } = input;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (edits.displayName !== undefined) {
      setClauses.push(`"displayName" = $${paramIndex}`);
      values.push(edits.displayName);
      paramIndex++;
    }
    if (edits.defaultBranch !== undefined) {
      setClauses.push(`"defaultBranch" = $${paramIndex}`);
      values.push(edits.defaultBranch);
      paramIndex++;
    }
    if (edits.host !== undefined) {
      setClauses.push(`"host" = $${paramIndex}`);
      values.push(edits.host);
      paramIndex++;
    }
    if (edits.needsVisualReview !== undefined) {
      setClauses.push(`"needsVisualReview" = $${paramIndex}`);
      values.push(edits.needsVisualReview);
      paramIndex++;
    }
    if (archived !== undefined) {
      setClauses.push(archived ? `"archivedAt" = CURRENT_TIMESTAMP` : `"archivedAt" = NULL`);
    }

    if (setClauses.length === 0) {
      const currentRows = await ctx.db.$queryRawUnsafe<RawRepoRow[]>(
        `SELECT ${REPO_COLUMNS} FROM "Repo" WHERE "id" = $1`,
        id,
      );
      const current = currentRows[0];
      if (!current) {
        throw new NotFoundError(`No such repo: ${id}.`, { fields: ["id"] });
      }
      return toRepoRecord(current);
    }

    values.push(id);
    const rows = await ctx.db.$queryRawUnsafe<RawRepoRow[]>(
      `UPDATE "Repo" SET ${setClauses.join(", ")} WHERE "id" = $${paramIndex} RETURNING ${REPO_COLUMNS}`,
      ...values,
    );
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundError(`No such repo: ${id}.`, { fields: ["id"] });
    }
    return toRepoRecord(updated);
  },
});
