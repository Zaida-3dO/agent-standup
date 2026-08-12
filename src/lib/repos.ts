// Repos (SCHEMA.md §23.1, DECISIONS.md §13g) — created DELIBERATELY. A wrong
// repository aims the merge gate at the wrong repository, and creating one
// is rare, so unlike areas.ts there is no find-or-create/auto-create path
// anywhere in this module — `createRepo` is the only way a `Repo` row comes
// into existence, and it fails loudly if the id already exists rather than
// silently reusing it.
import type { PrismaClient } from "@prisma/client";

export class RepoAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`repo already exists: ${JSON.stringify(id)}`);
    this.name = "RepoAlreadyExistsError";
  }
}

export interface CreateRepoInput {
  id: string;
  displayName: string;
  defaultBranch: string;
  host?: string | null;
  needsVisualReview?: boolean;
}

/**
 * The one and only path that creates a `Repo` row. Every field the caller
 * cares about is required or explicitly defaulted here — there is no
 * upsert, no "get or create", and no importer code path that reaches this
 * table at all (the importer, #10, resolves against repos that already
 * exist and maps aliases of one repository onto one id; it is explicitly
 * NOT permitted to mint a new `Repo` row as a side effect).
 */
export async function createRepo(
  client: Pick<PrismaClient, "repo">,
  input: CreateRepoInput,
): Promise<{ id: string; displayName: string; defaultBranch: string }> {
  const existing = await client.repo.findUnique({ where: { id: input.id } });
  if (existing) {
    throw new RepoAlreadyExistsError(input.id);
  }

  const repo = await client.repo.create({
    data: {
      id: input.id,
      displayName: input.displayName,
      defaultBranch: input.defaultBranch,
      host: input.host ?? null,
      needsVisualReview: input.needsVisualReview ?? false,
    },
  });

  return {
    id: repo.id,
    displayName: repo.displayName,
    defaultBranch: repo.defaultBranch,
  };
}

/** All non-archived repos, for admin listing and item-form dropdowns. */
export async function listActiveRepos(
  client: Pick<PrismaClient, "repo">,
): Promise<Array<{ id: string; displayName: string }>> {
  return client.repo.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true },
    orderBy: { id: "asc" },
  });
}
