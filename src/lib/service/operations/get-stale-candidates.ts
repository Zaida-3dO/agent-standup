// `get_stale_candidates` — open rows that another row's recorded work has
// already named, so a crew is not dispatched to rebuild something that
// already landed.
//
// ── The failure this exists to catch ────────────────────────────────────
//
// A row goes stale in exactly the case where the work went WELL: somebody
// fixed the thing efficiently as part of adjacent work and never came back
// to the row that described it. Every mechanism that could record the link
// exists — a `commit` artifact carrying a sha, a transition — and every one
// is manual and after the fact, performed against the row the session was
// working on rather than the row it incidentally satisfied.
//
// Measured, not hypothetical: in one triage pass twenty-two of twenty-seven
// rows in a single cluster were already fixed, six of them top priority and
// minutes from having crews dispatched onto them. The bad outcome is not a
// wasted dispatch, it is a rebuild that is worse than the working code it
// replaced.
//
// ── Why this is an operation rather than a script ───────────────────────
//
// A signal nobody sees is the problem restated. A report that requires a
// checkout, a forge credential and someone remembering to run it is
// available only to a person who already suspects the answer, which is the
// one person it cannot help. Registering it as an operation is what puts it
// in front of the caller who is about to dispatch, on whichever surface
// they happen to be using, because every adapter is derived from the
// registry.
//
// ── This never closes anything ──────────────────────────────────────────
//
// It reports candidates and the evidence for each, and takes no position on
// whether a row is satisfied. That is a deliberate bound rather than
// timidity. A citation is not proof the citing work met the cited row's
// acceptance criteria: partial shipping is real and recorded, and rows have
// been found where one finding closed while another stayed open under the
// same id — an automatic close would have hidden the open half. Two further
// shapes of staleness are invisible to this signal entirely: a row whose
// premise was false from the start, and a row whose premise evaporated when
// a later change deleted the thing it described. The second closes cleanly
// if nobody is paying attention and takes a genuine gap with it. So the
// output is input to a judgement, and the operation's `summary` says so.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { NOT_ARCHIVED_CONDITION } from "../items/row";
import { TERMINAL_STATES } from "../board/columns";
import { findCitedRows, CITING_ARTIFACT_KINDS } from "@/lib/reconcile/citations";
import type { CitableItem, CitedArtifact, CitationCandidate } from "@/lib/reconcile/types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many artifacts are scanned for citations, newest first.
 *
 * Bounded because this is a full-text scan over a table that grows without
 * limit, on a read a caller may make before every dispatch. Newest-first is
 * the right window: the citation that makes a row stale is written by the
 * work that superseded it, which is by definition more recent than the row.
 *
 * Its own constant rather than reusing the row `limit`: they bound
 * different things, and tying them together would mean asking for fewer
 * candidates silently searched less evidence — which is exactly the shape
 * of a read that quietly reports "nothing found" for the wrong reason.
 */
const ARTIFACT_SCAN_LIMIT = 2_000;

const inputSchema = z
  .object({
    /**
     * Narrow to one repository. Rows carry a nullable `repo`, so a caller
     * triaging one codebase's backlog can exclude every other board.
     */
    repo: z.string().min(1).optional(),
    /** Narrow to one area, the same way the board's own filters do. */
    area: z.string().min(1).optional(),
    /**
     * Include rows whose only citing evidence is a plan or a review, rather
     * than a commit. Off by default: "somebody was thinking about this" is
     * a much weaker claim than "something shipped", and mixing the two
     * makes the strong signal harder to act on.
     */
    includeUnlanded: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export type GetStaleCandidatesInput = z.infer<typeof inputSchema>;

export interface GetStaleCandidatesOutput {
  readonly candidates: readonly CitationCandidate[];
  /** How many open rows were examined, so an empty result is interpretable. */
  readonly rowsChecked: number;
  /** How many artifacts were scanned, and whether that hit the ceiling. */
  readonly artifactsScanned: number;
  readonly artifactScanTruncated: boolean;
  /**
   * What this read could NOT determine, carried in the payload rather than
   * left to a caller's memory. A caller acting on a candidate needs the
   * caveats at the same moment it reads the candidate, not in a document.
   */
  readonly caveats: readonly string[];
}

interface RawItemRow {
  id: string;
  title: string;
  state: string;
  headline: string | null;
  repo: string | null;
  priority: string | null;
  updatedAt: Date | null;
}

interface RawArtifactRow {
  id: string;
  itemId: string;
  kind: string;
  body: string | null;
  ref: string | null;
  commitSha: string | null;
  createdAt: Date | null;
  itemTitle: string | null;
  itemState: string | null;
}

/**
 * The caveats, as data.
 *
 * Written here rather than in the summary because they are about a
 * particular ANSWER — a caller holding three candidates needs to know what
 * the three do and do not prove — and because a caller on a surface that
 * renders structured output can show them beside the rows they qualify.
 */
const CAVEATS: readonly string[] = Object.freeze([
  "A citation is evidence someone worked on this row's subject elsewhere. It is not a check that the row's acceptance criteria were met — partial shipping is real, and a row can have one finding closed and another still open.",
  "Rows absent from this list are NOT confirmed outstanding. This uses one signal: another row's artifact naming this row's id. Work that shipped without citing the row produces no candidate and no warning.",
  "A row whose premise was false from the start, or whose premise a later change deleted, is invisible here. The second closes cleanly if nobody is paying attention and takes a genuine gap with it.",
]);

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getStaleCandidates = defineOperation({
  name: "get_stale_candidates",
  kind: "read",
  summary:
    "Finds open rows that another row's recorded work already named, so a stale row is caught before a crew is dispatched onto it. Reports evidence and closes nothing — a citation is not proof the row was satisfied. Narrow with repo, area or limit.",
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["includeUnlanded"],
        rule: "Defaults to false, so only rows cited by work that actually landed (a commit or a merge override) are returned. Pass true to also see rows named only by a plan or a review.",
      },
    ],
    example: { repo: "web", limit: 20 },
  },
  async handler(
    ctx: ServiceContext,
    input: GetStaleCandidatesInput,
  ): Promise<GetStaleCandidatesOutput> {
    const conditions: string[] = [NOT_ARCHIVED_CONDITION];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Open rows only. A terminal row cannot be stale in the sense that
    // matters here — the cost this read exists to prevent is a dispatch,
    // and nothing is dispatched onto finished work.
    conditions.push(`"state" != ALL($${paramIndex}::"ItemState"[])`);
    values.push(TERMINAL_STATES);
    paramIndex++;

    if (input.repo !== undefined) {
      conditions.push(`"repo" = $${paramIndex}`);
      values.push(input.repo);
      paramIndex++;
    }
    if (input.area !== undefined) {
      conditions.push(`"area" = $${paramIndex}`);
      values.push(input.area);
      paramIndex++;
    }

    const itemRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT "id", "title", "state", "headline", "repo", "priority", "updatedAt"
         FROM "Item"
        WHERE ${conditions.join(" AND ")}`,
      ...values,
    );

    const items: CitableItem[] = itemRows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      headline: row.headline,
      repo: row.repo,
      priority: row.priority,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    }));

    // One extra row, so "did the scan hit its ceiling" is a fact this query
    // establishes rather than an inference from the page being full. That
    // matters more here than in an ordinary paged read: a truncated scan
    // can report zero candidates, and a caller must be able to tell that
    // from a scan that genuinely found none.
    const artifactRows = await ctx.db.$queryRawUnsafe<RawArtifactRow[]>(
      `SELECT a."id", a."itemId", a."kind"::text AS "kind", a."body", a."ref",
              a."commitSha", a."createdAt", i."title" AS "itemTitle",
              i."state"::text AS "itemState"
         FROM "Artifact" a
         JOIN "Item" i ON i."id" = a."itemId"
        WHERE a."kind"::text = ANY($1::text[])
          AND (a."body" IS NOT NULL OR a."ref" IS NOT NULL)
        ORDER BY a."createdAt" DESC, a."seq" DESC
        LIMIT $2`,
      CITING_ARTIFACT_KINDS,
      ARTIFACT_SCAN_LIMIT + 1,
    );

    const truncated = artifactRows.length > ARTIFACT_SCAN_LIMIT;
    const scanned = truncated ? artifactRows.slice(0, ARTIFACT_SCAN_LIMIT) : artifactRows;

    const artifacts: CitedArtifact[] = scanned.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      kind: row.kind,
      body: row.body,
      ref: row.ref,
      commitSha: row.commitSha,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      itemTitle: row.itemTitle,
      itemState: row.itemState,
    }));

    let candidates = findCitedRows({ items, artifacts });
    if (!input.includeUnlanded) {
      candidates = candidates.filter((candidate) => candidate.confidence === "high");
    }

    return {
      candidates: candidates.slice(0, input.limit),
      rowsChecked: items.length,
      artifactsScanned: scanned.length,
      artifactScanTruncated: truncated,
      caveats: CAVEATS,
    };
  },
});
