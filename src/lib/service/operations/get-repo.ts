// `get_repo` — SCHEMA.md §19 `GET /repos/{id}`. MILESTONES.md #92.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { REPO_COLUMNS, toRepoRecord, type RawRepoRow, type RepoRecord } from "../admin/repo-row";

const inputSchema = z.object({ id: z.string().min(1) }).strict();

export type GetRepoInput = z.infer<typeof inputSchema>;

export const getRepo = defineOperation({
  name: "get_repo",
  kind: "read",
  summary: "Reads one repository by id.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetRepoInput): Promise<RepoRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawRepoRow[]>(
      `SELECT ${REPO_COLUMNS} FROM "Repo" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such repo: ${input.id}.`, { fields: ["id"] });
    }
    return toRepoRecord(row);
  },
});
