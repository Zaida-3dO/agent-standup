// `list_repos` — SCHEMA.md §19 `GET /repos`, §23.1, §23.3. MILESTONES.md #92.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { REPO_COLUMNS, toRepoRecord, type RawRepoRow, type RepoRecord } from "../admin/repo-row";

const inputSchema = z
  .object({
    includeArchived: z.boolean().default(false),
  })
  .strict();

export type ListReposInput = z.infer<typeof inputSchema>;

export interface ListReposOutput {
  readonly repos: readonly RepoRecord[];
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const listRepos = defineOperation({
  name: "list_repos",
  kind: "read",
  summary: "Lists repositories, active only by default.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListReposInput): Promise<ListReposOutput> {
    const where = input.includeArchived ? "" : `WHERE "archivedAt" IS NULL`;
    const rows = await ctx.db.$queryRawUnsafe<RawRepoRow[]>(
      `SELECT ${REPO_COLUMNS} FROM "Repo" ${where} ORDER BY "id" ASC`,
    );
    return { repos: rows.map(toRepoRecord) };
  },
});
