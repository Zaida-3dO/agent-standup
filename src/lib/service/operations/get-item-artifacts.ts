// `get_item_artifacts` — one item's artifacts, addressably and under a bound.
//
// **The gap this closes.** Until this operation existed, no read returned an
// artifact addressably. `get_item_detail` was the only call that returned
// artifacts at all, and it returned *every* one of them with full `body` and
// `findings` and no `LIMIT` — so on a long-lived item the artifacts were
// frequently the reason the response-size guard refused the call, and the
// refusal's own advice named no route that reached them. Two sessions
// reported the same dead end within a day: one tried six different calls
// looking for a plan it had recorded, another lost a spec it had written
// into an artifact body. `historyLimit` did not help, because it bounds the
// ledger rather than the artifacts — the wrong axis.
//
// So the shape here is chosen for the caller who has just been refused:
// they know the item, they want one plan or the newest review, and they
// need it without re-reading everything else attached to the item.
//
// ── Why this is a separate operation rather than more parameters ─────────
//
// `get_item_detail` gains an `artifactLimit` in the same change, and that is
// genuinely useful, but it cannot be the whole answer: lowering a limit
// returns *fewer* artifacts, and the caller who was refused wants a
// *specific* one. A bound and a selector are different tools. This one owns
// selection — by `kind`, by `artifactId`, and by page — and `get_item_detail`
// keeps owning the whole-item snapshot.
//
// ── Newest first, deliberately opposite to `get_item_detail` ─────────────
//
// `get_item_detail` orders artifacts `reviewRound ASC, createdAt ASC, seq
// ASC`, and that ordering is load-bearing there: the client-side mirrors in
// `item-detail/view.ts` (`currentTipCommitSha`, `newestVerification`,
// `latestVerdict`) scan that array forward keeping the *last* match, so ASC
// is what makes "last seen" mean "most recent" for them.
//
// This operation serves nobody who does that walk. Its caller wants the
// most recent plan or review at the top of page one, so it orders `seq
// DESC`. That is a deliberate divergence, not drift — stated here so a
// reviewer comparing the two queries does not read it as a mistake, and so
// that anyone tempted to "fix" the inconsistency knows which side each
// ordering serves.
//
// **The slim shape is the default**, the same convention `get_item_history`
// and `get_events` follow for the same reason: `body` and `findings` are the
// two unbounded columns on this table, and a read that returns them for
// every artifact grows without limit as an item is worked.
// A 200-character `bodyPreview` is enough to recognise which artifact you
// want; `full: true` or an `artifactId` then fetches it whole.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveItemId } from "../items/resolve-id";
import { ARTIFACT_KINDS } from "./record-artifact";

const inputSchema = z
  .object({
    /** The item's id — a full UUID, or a short id that is a prefix of one. */
    id: z.string().min(1),
    /**
     * One artifact, in full, by its id. When given, paging and `kind` are
     * ignored and `full` is implied — asking for a named artifact is asking
     * for its contents, and a caller who has gone to the trouble of naming
     * one does not want a 200-character preview of it.
     *
     * This is the direct answer to the "I recorded a plan and now cannot
     * read it back" report: the id is in the `record_artifact` response the
     * caller already holds.
     */
    artifactId: z.string().min(1).optional(),
    /**
     * Return only this kind. The reviewer's case — "the latest code_review
     * on this item" — is a `kind` filter plus the newest-first order, and
     * without it that question costs a full page of unrelated artifacts.
     */
    kind: z.enum(ARTIFACT_KINDS).optional(),
    /**
     * Return each artifact's `body` and `findings` as well. Off by default —
     * see the module header. Implied when `artifactId` is given.
     */
    full: z.boolean().default(false),
    /**
     * How many artifacts this page holds. Capped at the same 200 every other
     * paged read in the product uses, so a caller learns one bound rather
     * than one per operation.
     */
    limit: z.number().int().min(1).max(200).default(20),
    /**
     * The `seq` of the last artifact on the previous page. Keyset rather
     * than offset, for the reason `get_item_history`'s header sets out at
     * length: `Artifact` is append-only, and an `OFFSET` over a table
     * receiving inserts is the shape that silently repeats and drops rows.
     * Walking `seq` strictly downward means rows written between pages land
     * above the cursor and cannot disturb the page being read.
     *
     * Digits-only **here**, in the schema, rather than left to fail on the
     * `::bigint` cast in Postgres. Both refuse, but only this one refuses as
     * `invalid_input` naming the field — a cast failure surfaces as an
     * internal error, reporting a caller's typo as a server fault.
     */
    cursor: z
      .string()
      .regex(/^\d+$/, "cursor must be an artifact seq — a whole number, as returned in nextCursor")
      .optional(),
  })
  .strict();

export type GetItemArtifactsInput = z.infer<typeof inputSchema>;

/** One artifact in the slim shape — everything but the two unbounded columns. */
export interface ItemArtifactSlim {
  readonly id: string;
  readonly kind: string;
  readonly verdict: string | null;
  readonly reviewRound: number;
  readonly commitSha: string | null;
  readonly ref: string | null;
  readonly followUpItemId: string | null;
  readonly createdByType: string;
  readonly createdById: string;
  readonly createdAt: string;
  /**
   * The first `ARTIFACT_BODY_PREVIEW_CHARS` characters of `body`, so a caller can
   * tell which artifact this is without paying for all of it. Null when the
   * artifact has no body at all — distinct from an empty preview of a body
   * that exists.
   */
  readonly bodyPreview: string | null;
  /**
   * Whether `bodyPreview` was cut. Reported rather than inferred from its
   * length — which a caller cannot do correctly anyway, since the preview is
   * cut to a number of CHARACTERS and a JS `.length` counts UTF-16 code
   * units. True exactly when `bodyChars` exceeds `ARTIFACT_BODY_PREVIEW_CHARS`.
   */
  readonly bodyTruncated: boolean;
  /**
   * How long the full body is. The number a caller needs to decide whether
   * fetching it with `full` is worth it — and, on a refused item, whether it
   * will fit at all.
   */
  readonly bodyChars: number;
}

/** The slim shape plus the two unbounded columns. */
export interface ItemArtifactFull extends ItemArtifactSlim {
  readonly body: string | null;
  readonly findings: unknown;
}

export interface GetItemArtifactsOutput {
  /** Newest first. Slim unless `full` or `artifactId` was given. */
  readonly artifacts: readonly (ItemArtifactSlim | ItemArtifactFull)[];
  /**
   * How many artifacts match — the whole item's count, or the count for
   * `kind` when one was given, so "page 2 of 9" is answerable. Counted in
   * the same transaction as the page, so the two describe one snapshot.
   */
  readonly total: number;
  /**
   * The `seq` of the last artifact on this page, to pass back as `cursor`.
   * Null when this page is the last — a fact, read from one row beyond the
   * page, rather than an inference from a page that happens to be exactly
   * `limit` long.
   */
  readonly nextCursor: string | null;
}

interface RawArtifactRow {
  id: string;
  seq: bigint;
  kind: string;
  verdict: string | null;
  reviewRound: number;
  commitSha: string | null;
  ref: string | null;
  followUpItemId: string | null;
  createdByType: string;
  createdById: string;
  createdAt: Date;
  bodyChars: bigint | number | null;
  body?: string | null;
  findings?: unknown;
}

/**
 * The columns the slim shape selects — everything but `body` and `findings`.
 *
 * `length("body")` is computed in Postgres rather than by sending the body
 * here to measure it, which would defeat the entire point of the slim shape.
 * The 200-character preview is likewise cut with `left()` server-side: a
 * `slice(0, 200)` in JS would still transfer a 40,000-character body across
 * the wire first.
 *
 * Exported so a test can assert what is actually asked of Postgres. The
 * handler builds the slim object field by field, so a query that selected
 * the unbounded columns anyway would return the right *shape* while paying
 * the full transfer cost — a mistake no assertion on the response can see.
 */
/**
 * How much of a body the slim shape previews. 200 characters, the same
 * length `loop-reads.ts` settled on for the same judgement — enough to
 * recognise which artifact this is, short enough that a page of them stays
 * far inside the response-size guard.
 */
export const ARTIFACT_BODY_PREVIEW_CHARS = 200;

export const SLIM_ARTIFACT_COLUMNS = `"id", "seq", "kind"::text AS "kind", "verdict"::text AS "verdict",
              "reviewRound", "commitSha", "ref", "followUpItemId",
              "createdByType"::text AS "createdByType", "createdById", "createdAt",
              length("body") AS "bodyChars", left("body", ${ARTIFACT_BODY_PREVIEW_CHARS}) AS "bodyPreviewRaw"`;

/** The slim columns plus the two unbounded ones. */
export const FULL_ARTIFACT_COLUMNS = `${SLIM_ARTIFACT_COLUMNS}, "body", "findings"`;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getItemArtifacts = defineOperation({
  name: "get_item_artifacts",
  kind: "read",
  summary:
    'One item\'s artifacts, newest first and paged — plans, reviews, commits and check runs, reachable when get_item with full: "detail" is too large to return. Returns each without its body and findings; pass full for those, or artifactId for one in full.',
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: GetItemArtifactsInput,
  ): Promise<GetItemArtifactsOutput> {
    // Resolved once, up front, for the same reason `get_item_detail` and
    // `get_item_history` resolve once: a short id must not match one item
    // for the count and a different one for the page.
    const id = await resolveItemId(ctx.db, input.id);

    // The item's existence is checked explicitly, because nothing else here
    // would notice its absence: `resolveItemId` returns an unknown-but-
    // well-formed reference untouched, and this operation's reads are over
    // `Artifact`, where an unknown item simply has no rows. Without this,
    // asking for a nonexistent item would return an empty list and a total
    // of zero — indistinguishable from a real item nobody has recorded
    // anything against. `get_item_detail` refuses the same reference, and
    // two reads disagreeing about whether an item exists is exactly the
    // inconsistency that sends a caller looking for a bug in their own code.
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      id,
    );
    if (!itemRows[0]) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    // ── One artifact by id ────────────────────────────────────────────────
    //
    // Scoped to the item as well as the artifact id, so a caller cannot read
    // an artifact off an item they did not name by pasting an id from
    // somewhere else. The miss is reported the same way whether the id is
    // unknown or belongs to another item — which is the intended behaviour,
    // not an oversight: "not on this item" is the honest answer to the
    // question asked, and distinguishing the two would disclose the
    // existence of artifacts on items the caller did not ask about.
    if (input.artifactId !== undefined) {
      const rows = await ctx.db.$queryRawUnsafe<RawArtifactRow[]>(
        `SELECT ${FULL_ARTIFACT_COLUMNS}
         FROM "Artifact" WHERE "itemId" = $1 AND "id" = $2`,
        id,
        input.artifactId,
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError(`No such artifact on item ${id}: ${input.artifactId}.`, {
          fields: ["artifactId"],
        });
      }
      return {
        artifacts: [toFull(row)],
        total: 1,
        nextCursor: null,
      };
    }

    // ── A page ────────────────────────────────────────────────────────────

    const filterValues: unknown[] = [id];
    let kindCondition = "";
    if (input.kind !== undefined) {
      kindCondition = `AND "kind" = $2::"ArtifactKind"`;
      filterValues.push(input.kind);
    }

    const countRows = await ctx.db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Artifact"
       WHERE "itemId" = $1 ${kindCondition}`,
      ...filterValues,
    );
    const total = Number(countRows[0]?.count ?? 0);

    const values = [...filterValues];
    let paramIndex = values.length + 1;
    let cursorCondition = "";
    if (input.cursor !== undefined) {
      // `seq < cursor` on a single monotonic bigint — no tie-break column is
      // needed because `seq` is unique per row. Ordering by `seq` rather
      // than `createdAt` is deliberate: two artifacts can share a
      // millisecond, so `createdAt` alone is not a total order and a cursor
      // over it could repeat or skip rows. `seq` exists precisely to break
      // that tie (see the `artifact_insertion_seq` migration).
      //
      // The schema has already guaranteed this is all digits, so the cast
      // cannot fail here.
      cursorCondition = `AND "seq" < $${paramIndex}::bigint`;
      values.push(input.cursor);
      paramIndex++;
    }

    // One row beyond the page, so "there is more" is a fact rather than an
    // inference — the same trick `get_item_detail`, `get_item_history` and
    // `list_items` use.
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawArtifactRow[]>(
      `SELECT ${input.full ? FULL_ARTIFACT_COLUMNS : SLIM_ARTIFACT_COLUMNS}
       FROM "Artifact" WHERE "itemId" = $1 ${kindCondition} ${cursorCondition}
       ORDER BY "seq" DESC LIMIT $${paramIndex}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const artifacts = page.map((row) => (input.full ? toFull(row) : toSlim(row)));

    return {
      artifacts,
      total,
      nextCursor: hasMore ? (page[page.length - 1]?.seq.toString() ?? null) : null,
    };
  },
});

/**
 * The preview column the SELECT aliases, plus whether it was cut.
 *
 * `bodyTruncated` is decided by comparing the full length Postgres reported
 * against the budget that length was cut to — not by measuring the fragment
 * alone, which cannot tell a body of exactly 200 characters from one of
 * 40,000 cut down to 200.
 *
 * ── Why the budget and not `raw.length` ─────────────────────────────────
 *
 * This compared `bodyChars` against `raw.length`, which is two different
 * units on the two sides. `bodyChars` is Postgres `length("body")` and
 * counts CHARACTERS; `raw.length` is a JS string length and counts UTF-16
 * CODE UNITS. They agree for ASCII — which every fixture in this module's
 * suite happened to use — and disagree for anything astral, where one
 * character is two code units.
 *
 * The disagreement is not cosmetic: for an astral body in the 201-400
 * character band, `left("body", 200)` returns a 200-character fragment
 * whose `.length` is 400, the comparison `250 > 400` is false, and a body
 * that lost 50 characters was reported as `bodyTruncated: false` — handed
 * to the caller alongside a truthful `bodyChars: 250` and a preview holding
 * only 200 of them, an object contradicting itself. Above 400 it went true
 * again for the wrong reason and looked correct.
 *
 * `ARTIFACT_BODY_PREVIEW_CHARS` is the exact number handed to `left()`,
 * which cuts on characters, so this compares characters to characters and
 * is correct in every encoding. It is also the *question being asked* —
 * "was the body longer than what we kept" — rather than a proxy for it.
 */
function previewOf(row: RawArtifactRow): { bodyPreview: string | null; bodyTruncated: boolean } {
  const raw = (row as unknown as { bodyPreviewRaw: string | null }).bodyPreviewRaw;
  if (raw === null || raw === undefined) return { bodyPreview: null, bodyTruncated: false };
  return {
    bodyPreview: raw,
    bodyTruncated: Number(row.bodyChars ?? 0) > ARTIFACT_BODY_PREVIEW_CHARS,
  };
}

function toSlim(row: RawArtifactRow): ItemArtifactSlim {
  const { bodyPreview, bodyTruncated } = previewOf(row);
  return {
    id: row.id,
    kind: row.kind,
    verdict: row.verdict,
    reviewRound: Number(row.reviewRound),
    commitSha: row.commitSha,
    ref: row.ref,
    followUpItemId: row.followUpItemId,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    bodyPreview,
    bodyTruncated,
    bodyChars: Number(row.bodyChars ?? 0),
  };
}

function toFull(row: RawArtifactRow): ItemArtifactFull {
  return {
    ...toSlim(row),
    body: row.body ?? null,
    findings: row.findings ?? null,
  };
}
