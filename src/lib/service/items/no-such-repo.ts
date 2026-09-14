// The shared "No such repo" refusal — Ope's 2026-09-14 decision on the
// blocked item "Needs Ope: un-waive list_repos, or keep the indirect route"
// (`80c23a90-1070-4edf-b6c8-0a32209dca44`):
//
// > "let the agents see the repo list but not as a new tool, instead it can
// > be included in the failure message when trying to set a repo on a task
// > and the repo is invalid — we can return an error that includes a list
// > of the valid repo names"
//
// `list_repos` stays waived off MCP (DECISIONS.md's uniform 20-operation
// waiver class) and no new tool is added. Instead, every place that refuses
// an unrecognised `repo` builds the SAME message: the existence check
// already runs one query against `Repo`; this module is what that refusal
// says once the row is missing, so `create-core.ts` and `update-item.ts`
// (the two operations that validate a caller-supplied `repo`) say the exact
// same thing rather than drifting apart.
//
// **Capped, not dumped.** A refusal naming all 200 rows in an installation
// with 200 repos is its own problem (Acceptance Criterion 2) — the same
// concern `describeBlockingFindings` (`../guards/merge-findings.ts`) and
// `digest.ts`'s crew list already solve with "first N, and M more".
//
// **Near-miss first.** A caller who typed `Joda-creative-studio` for the
// real id `joda-creative-studio` is one case/punctuation slip away from a
// working call, and burying that match at position 140 of an alphabetical
// list defeats the whole point of listing anything. Sorted by Levenshtein
// distance to the caller's input (`../../near-duplicates.ts`, already used
// for the same purpose on areas) so the likely match leads.
import type { TransactionHandle } from "../context";
import { levenshtein } from "@/lib/near-duplicates";

/** How many repo ids the refusal names before falling back to "…and N more". */
const MAX_LISTED_REPOS = 10;

/**
 * All active (non-archived) repo ids, for building a refusal. A second,
 * narrow query — `SELECT id` only, no join, no ordering the caller cares
 * about — kept separate from the existence check that triggers it so the
 * common case (the id IS valid) never pays for it.
 */
async function activeRepoIds(db: TransactionHandle): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Repo" WHERE "archivedAt" IS NULL`,
  );
  return rows.map((row) => row.id);
}

/**
 * Builds the "No such repo" message: the bad input, then the valid set —
 * closest matches to the input first, capped, with a count of the rest.
 *
 * An empty repo table still gets a sensible message ("no repos are
 * registered yet") rather than an empty, punctuation-only list — the honest
 * gap the shipped partial fix admitted to (a repo with no items filed
 * against it yet is still invisible to the indirect `get_board`/
 * `list_items` route, but IS in this list, because this queries the `Repo`
 * table directly rather than inferring repos from items).
 */
export async function noSuchRepoMessage(db: TransactionHandle, badRepo: string): Promise<string> {
  const ids = await activeRepoIds(db);

  if (ids.length === 0) {
    return `No such repo: ${badRepo}. No repos are registered yet — repos are deliberate-create only (\`create_repo\` [http/cli]).`;
  }

  const sorted = [...ids].sort((a, b) => levenshtein(badRepo, a) - levenshtein(badRepo, b));
  const shown = sorted.slice(0, MAX_LISTED_REPOS);
  const remainder = sorted.length - shown.length;
  const listed = shown.join(", ");
  const suffix = remainder > 0 ? `, and ${remainder} more` : "";

  return `No such repo: ${badRepo}. Valid repos: ${listed}${suffix}.`;
}
