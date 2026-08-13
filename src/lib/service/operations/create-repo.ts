// `create_repo` — SCHEMA.md §19 `POST /repos`, §23.1: "Creating one is an
// explicit act… a wrong repository aims the merge gate at the wrong
// repository, and creating one is rare." MILESTONES.md #92.
//
// Deliberate creation, mirroring `../../repos.ts`'s `createRepo` (the
// non-service, importer-facing copy of this same rule) — there is no
// find-or-create here, unlike `create_area` below: a caller asking to
// create a repo that already exists is refused rather than silently handed
// the existing row, because the id colliding is far more likely to be a
// mistake than an intentional no-op for this entity.
import { z } from "zod";
import { ConflictError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { REPO_COLUMNS, toRepoRecord, type RawRepoRow, type RepoRecord } from "../admin/repo-row";

const inputSchema = z
  .object({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1),
    host: z.string().trim().min(1).optional(),
    needsVisualReview: z.boolean().default(false),
  })
  .strict();

export type CreateRepoInput = z.infer<typeof inputSchema>;

export const createRepo = defineOperation({
  name: "create_repo",
  kind: "write",
  summary: "Creates a repository. Refused if the id already exists.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateRepoInput): Promise<RepoRecord> {
    const existing = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Repo" WHERE "id" = $1`,
      input.id,
    );
    if (existing.length > 0) {
      throw new ConflictError(`Repo already exists: ${input.id}.`, { fields: ["id"] });
    }

    const rows = await ctx.db.$queryRawUnsafe<RawRepoRow[]>(
      `INSERT INTO "Repo" ("id", "displayName", "defaultBranch", "host", "needsVisualReview")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${REPO_COLUMNS}`,
      input.id,
      input.displayName,
      input.defaultBranch,
      input.host ?? null,
      input.needsVisualReview,
    );
    return toRepoRecord(rows[0]!);
  },
});
