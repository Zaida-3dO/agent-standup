// `delete_repo`, `delete_area`, `delete_person` — MILESTONES.md #96,
// SCHEMA.md §19, §23.1.
//
// ── Two operations, because "delete" means two different things ──────────
//
// Conflating them is what breaks the board, so they are kept apart by having
// separate names rather than by a flag:
//
//   - **Archiving** (`update_repo`/`update_area`/`update_person` with
//     `archived: true`) is the common, safe case and already exists. The row
//     stays, every item and attribution row still resolves, it just stops
//     being offered for new work. This is what a caller almost always wants.
//   - **Hard delete** — here — is for the genuine mistake: a repo created
//     with a typo, an area auto-created from a misspelling. Rows that should
//     never have existed, where archiving leaves permanent clutter in a table
//     meant to be small and readable.
//
// Note the asymmetry with `delete_item`, which is deliberate and is the whole
// reason this file exists separately. `delete_item` is *named* delete and
// never removes a row, because an item carries history and attribution that
// must keep resolving. A reference row with nothing pointing at it carries
// neither — there is no history to preserve, which is precisely what the
// guard below establishes before allowing the row to go.
//
// ── The guard is what makes it safe, and it is not advisory ──────────────
//
// Zero referring rows, counted at the moment of the request across every
// table holding the foreign key, or the request is refused and reports what
// still points at it. Deleting a referenced row either corrupts history or
// trips a foreign-key error at a random later read — the second being worse,
// because it surfaces far from the call that caused it.
//
// The count is taken inside the same transaction as the delete, so a row that
// acquires a reference between the check and the delete cannot slip through.
// The `hardDelete: true` flag is required on top of that: this operation
// cannot be reached by a caller who did not mean to reach it, which matters
// because the refusal is the only thing standing between a typo'd `id` and a
// row that a hundred items point at.
//
// ── Why the flag, when the operation is already named `delete_repo` ──────
//
// Because the overwhelmingly likely intent is archiving, and a caller who
// types `delete_repo` has usually reached past `update_repo` for the nearest
// verb — the same mistake `delete_item` refuses cancellation-shaped reasons
// to catch. An explicit `hardDelete: true` converts that reach into a moment
// where the caller has to say the row should genuinely cease to exist, and
// the refusal names archiving as the call to make instead.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ENTITY_TABLE,
  REFERRING_COLUMNS,
  describeReferenceCounts,
  type ReferenceCount,
  type ReferenceEntity,
} from "../admin/reference-counts";

/** The guard name a refusal carries, so adapters compare it rather than prose. */
export const REFERENCED_ROW_GUARD = "referenced_row_not_deletable";

/** The guard that refuses a hard delete nobody explicitly asked for. */
export const HARD_DELETE_FLAG_GUARD = "hard_delete_not_requested";

const inputSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Required, and required to be `true`. Omitting it is not "default to
     * archiving" — this operation does not archive, so a caller who has not
     * set it is told to call the update operation instead.
     */
    hardDelete: z.boolean().optional(),
  })
  .strict();

export type DeleteReferenceRowInput = z.infer<typeof inputSchema>;

export interface DeleteReferenceRowOutput {
  /** The id that was removed. */
  readonly id: string;
  /** Always `true` when this returns — a refusal throws rather than reporting false. */
  readonly deleted: true;
}

/**
 * Counts every inbound reference to `id`, one query per referring column.
 *
 * Separate queries rather than one `UNION` on purpose: the refusal reports
 * *which* kind of reference survives, and a single total would tell a caller
 * that something points at the row without telling them where to look.
 */
async function countReferences(
  ctx: ServiceContext,
  entity: ReferenceEntity,
  id: string,
): Promise<ReferenceCount[]> {
  const counts: ReferenceCount[] = [];
  for (const ref of REFERRING_COLUMNS[entity]) {
    const rows = await ctx.db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "${ref.table}" WHERE "${ref.column}" = $1`,
      id,
    );
    counts.push({
      table: ref.table,
      column: ref.column,
      label: ref.label,
      // `COUNT(*)` comes back as a bigint through the raw driver; a plain
      // `Number` is correct here because a count that overflows a double
      // would mean ~9 quadrillion referring rows.
      count: Number(rows[0]?.count ?? 0),
    });
  }
  return counts;
}

/** What each entity is called in a message, and how its archive is spelled. */
const ENTITY_WORDS: Record<ReferenceEntity, { readonly noun: string; readonly archiveOp: string }> =
  {
    repo: { noun: "repo", archiveOp: "update_repo" },
    area: { noun: "area", archiveOp: "update_area" },
    person: { noun: "person", archiveOp: "update_person" },
  };

/**
 * The whole substance of all three operations: both guards, then the delete.
 *
 * A shared function rather than three hand-written copies, because three
 * copies of a guard is three chances for one to drift into being weaker
 * than the others. Only the `defineOperation` *declarations* are repeated
 * below, and they are repeated deliberately — see the note on them.
 */
async function deleteReferenceRow(
  ctx: ServiceContext,
  entity: ReferenceEntity,
  input: DeleteReferenceRowInput,
): Promise<DeleteReferenceRowOutput> {
  const words = ENTITY_WORDS[entity];
  const table = ENTITY_TABLE[entity];
  const { id } = input;

  if (input.hardDelete !== true) {
    throw new GuardRejectedError(
      HARD_DELETE_FLAG_GUARD,
      `Pass hardDelete: true to permanently remove this ${words.noun}. This is almost never what you want — archiving with ${words.archiveOp} keeps the row so every item already referencing it still resolves, and only stops it being offered for new work. Hard delete exists for a ${words.noun} that should never have existed, such as one created with a typo.`,
      { fields: ["hardDelete"] },
    );
  }

  const existing = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "${table}" WHERE "id" = $1`,
    id,
  );
  if (existing.length === 0) {
    throw new NotFoundError(`No such ${words.noun}: ${id}.`, { fields: ["id"] });
  }

  const counts = await countReferences(ctx, entity, id);
  const referenced = counts.filter((entry) => entry.count > 0);
  if (referenced.length > 0) {
    throw new GuardRejectedError(
      REFERENCED_ROW_GUARD,
      `Cannot delete ${words.noun} "${id}" — ${describeReferenceCounts(counts)} still reference it. Deleting it would orphan them. Archive it instead with ${words.archiveOp} (archived: true): the row stays and every reference keeps resolving, it just stops being offered for new work.`,
      { fields: ["id"] },
    );
  }

  await ctx.db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id);

  return { id, deleted: true };
}

// ── Why these three are spelled out rather than built by a factory ───────
//
// A factory taking the name as an argument works at run time and typechecks
// (given `<const Name extends string>`), and it was the first shape tried.
// It is wrong here for a reason worth recording, because it fails *silently*
// in the direction that matters:
//
// `tests/service-registry.test.ts` finds every operation by regex over this
// directory's source — it looks for a `defineOperation` call opening with a
// literal `name:` — precisely so that the check "cannot consult the thing it
// is checking". (Spelled out rather than quoted verbatim on purpose: both
// scanners match that literal anywhere on a line, so quoting it in prose
// makes this comment itself read as a fourth, unannotated declaration.
// `check:operation-metadata` fails on it.) An operation whose name
// arrives as a variable is invisible to that scan, so a future operation in
// this file could be declared, never registered, and the canonical-registry
// test would still pass. The same is true of
// `scripts/check-operation-metadata-mutants.mjs`.
//
// So the shared logic lives in `deleteReferenceRow` above and only the
// declarations repeat. The repetition is three lines each and is what keeps
// both checks able to see these operations.

// Stryker disable all : registry metadata, evaluated at import before any
// test body runs and never re-evaluated, so a mutation here is unkillable by
// construction — NOT untested (`tests/service-registry.test.ts` asserts the
// whole registry's metadata). `scripts/check-operation-metadata-mutants.mjs`
// requires this annotation and carries the full reasoning.
export const deleteRepo = defineOperation({
  name: "delete_repo",
  kind: "write",
  summary: "Permanently removes a repo, refused unless nothing references it.",
  // Stryker restore all
  input: inputSchema,
  handler: (ctx: ServiceContext, input: DeleteReferenceRowInput) =>
    deleteReferenceRow(ctx, "repo", input),
});

// Stryker disable all : see the annotation on `deleteRepo`.
export const deleteArea = defineOperation({
  name: "delete_area",
  kind: "write",
  summary: "Permanently removes an area, refused unless nothing references it.",
  // Stryker restore all
  input: inputSchema,
  handler: (ctx: ServiceContext, input: DeleteReferenceRowInput) =>
    deleteReferenceRow(ctx, "area", input),
});

// Stryker disable all : see the annotation on `deleteRepo`.
export const deletePerson = defineOperation({
  name: "delete_person",
  kind: "write",
  summary: "Permanently removes a person, refused unless nothing references it.",
  // Stryker restore all
  input: inputSchema,
  handler: (ctx: ServiceContext, input: DeleteReferenceRowInput) =>
    deleteReferenceRow(ctx, "person", input),
});
