// The backfill payload — **the public contract** (docs/plans/BACKFILL.md).
//
// This schema is the interface between this application and any converter
// somebody writes for their own existing store. It is the one thing an
// outside author has to satisfy, so it is deliberately written down as a
// versioned, validated shape rather than left implicit in whatever the
// importer happened to accept.
//
// Two properties make it a contract rather than a convenience:
//
//   1. **It is versioned.** `version` is a literal, checked on the way in.
//      A converter written against version 1 either matches version 1 or is
//      refused by name — it never half-works against a shape that has moved.
//   2. **It is `.strict()` throughout.** An unrecognised key is refused
//      rather than ignored, so a converter with a typo'd field name finds
//      out immediately instead of silently dropping the data it meant to
//      send. That is worth more than leniency here: this is a one-shot bulk
//      write, and the cheapest moment to discover a mistake is before any
//      of it lands.
//
// Nothing in this module knows where a payload came from. It describes a
// shape; producing one is the converter's problem, and every field below is
// named for what it means in *this* schema, never for the source it may
// have been read out of.
import { z } from "zod";

/** The only payload version this build accepts. */
export const BACKFILL_CONTRACT_VERSION = 1;

/**
 * **This application's own item states** (SCHEMA.md §1.1) — the target
 * vocabulary a caller maps onto, and the only status words this repository
 * knows.
 *
 * Written out here so the contract can validate a caller's mapping against
 * it. There is deliberately no table anywhere in this application
 * translating any *particular* source's status words into these: a source's
 * state machine belongs to the source, and hardcoding one would make every
 * other source a source-code change (and would put one external system's
 * private vocabulary into a public repository). The caller supplies
 * `statusAliases`; the application supplies these.
 */
export const ITEM_STATES = [
  "someday",
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
  "paused",
  "blocked",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
] as const;

/**
 * **This application's own review verdicts** (SCHEMA.md §6) — the target
 * vocabulary a caller maps onto.
 *
 * `approved` is kept alongside `lgtm` as an accepted synonym rather than
 * replaced: removing a label from a Postgres enum is a type rebuild rather
 * than an `ALTER`, so every verdict already on record keeps meaning exactly
 * what it meant.
 */
export const VERDICT_VALUES = [
  "approved",
  "changes_required",
  "na",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
] as const;

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a parseable timestamp",
  });

/**
 * One entry in a task's history log. Lands in `events` as a `note` row,
 * keyed on `id` for idempotency, with `at` preserved in the payload.
 */
const historyEntrySchema = z
  .object({
    /** Unique within the task. This is what makes a re-run skip rather than duplicate. */
    id: z.string().min(1),
    /** Free-text actor label, resolved through `actorAliases`. */
    actor: z.string().min(1),
    at: timestamp,
    note: z.string(),
  })
  .strict();

/** One historical claim on a task. Lands in `assignments`. */
const claimSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    /** `orchestrator` · `builder` · `reviewer` · `visual-reviewer` · `scout` · `custom`. */
    role: z.string().min(1),
    roleCustom: z.string().nullable().optional(),
    holderType: z.enum(["person", "agent"]),
    holderId: z.string().min(1),
    rootSessionId: z.string().min(1).nullable().optional(),
    parentSessionId: z.string().min(1).nullable().optional(),
    machine: z.string().min(1),
    claimedAt: timestamp,
    /** Absent or null = the claim was never released, i.e. it imports as still live. */
    releasedAt: timestamp.nullable().optional(),
  })
  .strict();

/** One artifact produced against a task — a review, a plan, a progress note. Lands in `artifacts`. */
const artifactSchema = z
  .object({
    id: z.string().min(1),
    /** `plan` · `plan_review` · `code_review` · `visual_review` · `test_run` · `commit` · `screenshot` · `other`. */
    kind: z.string().min(1),
    /** `approved` · `changes_required` · `na`. Absent = `na`. */
    verdict: z.string().nullable().optional(),
    reviewRound: z.number().int().min(0).optional(),
    commitSha: z.string().nullable().optional(),
    /** The artifact's own contents. Never validated or indexed — this is where anything the columns cannot hold survives. */
    body: z.string().nullable().optional(),
    /** Where it came from, as a path relative to the converter's own root. Never an absolute path. */
    ref: z.string().nullable().optional(),
    createdByType: z.enum(["person", "agent"]),
    createdById: z.string().min(1),
    createdAt: timestamp,
  })
  .strict();

/** One task. Everything but `id`, `title`, `body` and `status` is optional. */
const taskSchema = z
  .object({
    /** The converter's own identifier. Preserved as `custom_fields.legacy_id`; idempotency keys on it. */
    id: z.string().min(1),
    title: z.string().min(1),
    /** The durable brief. Lands verbatim in `items.body`. */
    body: z.string(),
    /** Status in the converter's vocabulary — remapped to `items.state`, and refused if unrecognised. */
    status: z.string().min(1),
    /** Overrides `defaultArea` for this task. Auto-created, normalised. */
    area: z.string().trim().min(1).optional(),
    /** Resolved through `repoAliases` only — never auto-created, because a wrong repo aims the merge gate wrongly. */
    repo: z.string().min(1).optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    branch: z.string().min(1).optional(),
    needsVisualReview: z.boolean().optional(),
    /** When the source says the work was created. Omitted stamps the import moment. */
    createdAt: timestamp.optional(),
    /** When the source last changed it. Omitted stamps the import moment. */
    updatedAt: timestamp.optional(),
    /** Who or what created it. Omitted defaults to `source`. */
    originType: z.enum(["person", "source", "auto"]).optional(),
    /** An existing `people.id`. Required when `originType` is `person`. */
    originPersonId: z.string().min(1).optional(),
    /** Omitted defaults to `needs_approval`. */
    mergeAuthority: z.enum(["pre_approved", "needs_approval", "agent_judgement"]).optional(),
    /** `path@content_hash`. Relative — an absolute path records the converting machine's layout. */
    sourceRef: z.string().min(1).optional(),
    /** Anything with no typed column, preserved verbatim. `legacy_id` here is always overridden. */
    customFields: z.record(z.string(), z.unknown()).optional(),
    history: z.array(historyEntrySchema).optional(),
    claims: z.array(claimSchema).optional(),
    /** Named `reviews` because that is what the artifacts importer calls its input; any artifact kind is accepted. */
    reviews: z.array(artifactSchema).optional(),
  })
  .strict()
  .refine((value) => value.originType !== "person" || value.originPersonId !== undefined, {
    message: "originPersonId is required when originType is person",
    path: ["originPersonId"],
  });

const actorAliasSchema = z
  .object({
    actorType: z.enum(["person", "agent", "system"]),
    /** Null only for `system` — the source attributed the row to nobody. */
    actorId: z.string().min(1).nullable(),
  })
  .strict()
  .refine((value) => value.actorType === "system" || value.actorId !== null, {
    message: "actorId is required unless actorType is system",
    path: ["actorId"],
  });

export const backfillPayloadSchema = z
  .object({
    version: z.literal(BACKFILL_CONTRACT_VERSION),
    /**
     * The area every task lands under unless it names its own.
     *
     * Validated here — not left to the area resolver — so that the only way
     * this operation can be refused is `invalid_input`. That matters beyond
     * tidiness: §22 forbids an adapter that exposes any write from waiving
     * an operation **a registered guard can reject**, and the MCP adapter
     * waives this one. Keeping every refusal on the schema is what makes
     * that waiver legal rather than merely convenient.
     */
    defaultArea: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.replace(/[\s_/-]+/g, "").length > 0, {
        message: "defaultArea must contain at least one character that is not a separator",
      }),
    /** Converter repo label -> an existing `repos.id`. A label with no entry is refused. */
    repoAliases: z.record(z.string(), z.string().min(1)).optional(),
    /** Converter actor label -> who the event is attributed to. A label with no entry is refused. */
    actorAliases: z.record(z.string(), actorAliasSchema).optional(),
    /**
     * Converter status label -> one of **this application's** item states
     * (`ITEM_STATES`).
     *
     * The third of the three alias maps, and the one that makes the
     * contract genuinely portable. A caller's status vocabulary is the
     * caller's — this application ships its twelve states and no table
     * translating anybody's words into them. A status with no entry here
     * falls back to the application's own small default vocabulary and, if
     * it is not there either, is refused rather than guessed at.
     */
    statusAliases: z.record(z.string(), z.enum(ITEM_STATES)).optional(),
    /**
     * Converter verdict spelling -> one of **this application's** verdicts
     * (`VERDICT_VALUES`).
     *
     * The fourth alias map, and it exists for a concrete reason rather than
     * symmetry: review vocabularies differ in punctuation as well as in
     * meaning — a source writing `lgtm-with-nits` has to say so, because
     * this application stores `lgtm_with_nits` and will not guess that a
     * hyphen was meant to be an underscore. A verdict with no entry falls
     * back to being taken literally, and is refused if it is not one of
     * ours.
     */
    verdictAliases: z.record(z.string(), z.enum(VERDICT_VALUES)).optional(),
    tasks: z.array(taskSchema),
  })
  .strict();

export type BackfillPayload = z.infer<typeof backfillPayloadSchema>;
export type BackfillTask = z.infer<typeof taskSchema>;
