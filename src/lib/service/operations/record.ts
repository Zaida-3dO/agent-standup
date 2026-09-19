// `record` — the four ways an agent writes down what happened, behind one tool.
//
// ── Why these four ──────────────────────────────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. These
// four are one act seen four times: an agent putting something on the
// record against an item it is working. A checkpoint is a resume point, a
// note is a remark, an artifact is a produced thing, a blocked-on-tool
// report is a capability gap — and a caller reaching for any of them has
// already decided it is writing to the record rather than reading it or
// moving the work. The remaining question is what kind of record, which is
// exactly what an `action` states.
//
// ── The one distinction a fold could bury, stated loudly ────────────────
//
// **`action: "checkpoint"` requires a LIVE ASSIGNMENT and `action: "note"`
// does not.** That is the single most-got-wrong thing about these two
// operations, and it is the one real cost of putting them behind one name:
// separate tools at least let a caller notice they were reaching for a
// different thing. So the asymmetry is stated in `contract.rules` below,
// where `describe_tool` returns it, rather than left to be discovered
// through a `conflict` refusal — and it is written the way `loop` writes
// its `kind` rule, as a sentence about when each is right rather than a
// list of which fields are required.
//
// The history is worth one line because it is why the wording is specific:
// four operations enforced assignment-backed preconditions while declaring
// no contract, three documents were written saying checkpoint needs no
// claim, and sessions were refused after following them. A fold that made
// that distinction *less* visible would be a net loss no tool-count saving
// pays for.
//
// ── No second implementation ────────────────────────────────────────────
//
// Each action dispatches to the operation that already performs it, through
// the same `ctx`, so a refusal a caller gets here is the *same object* the
// unfolded operation would have thrown — `code`, `guard` id and `fields`
// identical. `checkpoint`'s `conflict` for a missing assignment arrives
// through this tool unchanged, which `tests/record-fold.test.ts` observes
// rather than assumes.
//
// ── `artifactKind`, not `kind` ──────────────────────────────────────────
//
// `record_artifact` names its enum `artifactKind`. `loop` already uses
// `kind` for an unrelated three-value enum, and this tool's own
// discriminator is `action` — so a bare `kind` here would be the second
// meaning of that word on an adjacent tool. One unambiguous name per
// concept, which is what the rename in the commit before this one bought.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { rejectForeignFields, type FoldForwarding } from "../foreign-fields";
import { ARTIFACT_KINDS, recordArtifact } from "./record-artifact";
import { BLOCKED_ON_TOOL_REASONS, reportBlockedOnTool } from "./report-blocked-on-tool";
import { checkpoint } from "./checkpoint";
import { note } from "./note";

/** The verbs this tool folds. */
export const RECORD_ACTIONS = ["checkpoint", "note", "artifact", "blocked_on_tool"] as const;

export type RecordAction = (typeof RECORD_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is
 * made from, so a required field and the sentence naming it cannot
 * disagree. `describe_tool` reads this same table, so what the tool
 * advertises as required and what it actually refuses cannot drift.
 *
 * **`sessionId` is required on `checkpoint` and on nothing else**, and that
 * is the schema half of the asymmetry the contract rule below states in
 * prose. A checkpoint attributes to the assignment `itemId` + `sessionId`
 * identifies; a note attributes to the item alone.
 */
export const RECORD_ACTION_FIELDS: Readonly<
  Record<RecordAction, { readonly required: readonly string[] }>
> = Object.freeze({
  checkpoint: { required: ["itemId", "sessionId", "body"] },
  note: { required: ["itemId", "body"] },
  artifact: { required: ["itemId", "artifactKind"] },
  blocked_on_tool: { required: ["itemId", "tool", "needed"] },
});

const inputSchema = z
  .object({
    /** Which kind of record. The one field that decides what the rest means. */
    action: z.enum(RECORD_ACTIONS),
    /** The item being written against. Required by every action. */
    itemId: z.string().min(1).optional(),
    /**
     * The prose.
     *
     * Means something different per action, which is why it is one field
     * rather than four: on `checkpoint` it is what you tried and what is
     * next, on `note` it is the remark, on `artifact` it is the artifact's
     * text — and for a `pull_request` or `check_run` artifact it is a
     * STATUS rather than prose, which the artifact write's own contract
     * states and this tool does not restate.
     */
    body: z.string().min(1).optional(),

    // ── `checkpoint` ───────────────────────────────────────────────────
    /**
     * The session whose assignment this checkpoint attributes to.
     *
     * Required on `checkpoint`, optional everywhere else — see the contract
     * rule below. On `note` and `blocked_on_tool` it is attribution only
     * and never a precondition.
     */
    sessionId: z.string().min(1).nullable().optional(),
    /** A one-line BLUF, so a later session reads the point without the prose. */
    headline: z.string().min(1).optional(),

    // ── `note` ─────────────────────────────────────────────────────────
    /**
     * Left loose here and parsed by `note`'s own schema, which is where the
     * actor vocabulary lives. Restating the enum would put one list in two
     * places, and the delegate's `.strict()` parse refuses an unknown value
     * by name before any handler runs — the same reason `session` leaves
     * `hookVariant` loose.
     */
    actorType: z.string().min(1).optional(),
    actorId: z.string().min(1).nullable().optional(),

    // ── `artifact` ─────────────────────────────────────────────────────
    /**
     * Which kind of artifact.
     *
     * `artifactKind` rather than `kind`: `loop` uses `kind` for an
     * unrelated enum, and one word meaning two things on adjacent tools is
     * a guess a caller gets wrong half the time.
     */
    artifactKind: z.enum(ARTIFACT_KINDS).optional(),
    /** Left loose for the same reason as `actorType` — the delegate owns the vocabulary. */
    verdict: z.string().min(1).nullable().optional(),
    reviewRound: z.number().int().min(1).optional(),
    commitSha: z.string().min(1).nullable().optional(),
    supersedesSha: z.string().min(1).nullable().optional(),
    ref: z.string().min(1).nullable().optional(),
    browserSession: z.string().min(1).nullable().optional(),
    followUpItemId: z.string().min(1).nullable().optional(),
    createdByType: z.enum(["person", "agent"]).optional(),
    createdById: z.string().min(1).optional(),
    /**
     * Left loose here and parsed by `record_artifact`'s own schema, which is
     * where the finding shape lives. Restating it would put one structure in
     * two places, and the delegate's `.strict()` parse refuses anything it
     * does not recognise before any handler runs.
     */
    findings: z.array(z.unknown()).nullable().optional(),

    // ── `blocked_on_tool` ──────────────────────────────────────────────
    /** The tool that could not be used. One per report. */
    tool: z.string().min(1).optional(),
    /** What the brief asked be done with it — the field that makes the row actionable. */
    needed: z.string().min(1).optional(),
    /** The refusal text, verbatim, when there was one. */
    refusal: z.string().min(1).nullable().optional(),
    reason: z.enum(BLOCKED_ON_TOOL_REASONS).optional(),
  })
  .strict();

export type RecordInput = z.infer<typeof inputSchema>;

/**
 * Which delegate each action forwards to, for the foreign-field guard.
 *
 * The schemas themselves, not a list of their field names: the legitimate
 * set for an action IS what its delegate declares, and deriving it means
 * the guard cannot drift from the forwarding two dozen lines below. A field
 * added to `record_artifact` becomes acceptable on `action: "artifact"` the
 * moment it is declared there, with no edit here.
 *
 * `record` renames nothing on the way out — every field arrives under the
 * name the caller used — so there is no `renames` entry. The one name that
 * differs, `artifactKind` versus the delegate's own `artifactKind`, is the
 * same on both sides; it differs from `loop`'s `kind`, which is a different
 * tool entirely.
 */
const FORWARDING: FoldForwarding<RecordAction> = Object.freeze({
  checkpoint: { schema: checkpoint.input },
  note: { schema: note.input },
  artifact: { schema: recordArtifact.input },
  blocked_on_tool: { schema: reportBlockedOnTool.input },
});

/** Refuses an action that is missing a field it cannot run without. */
function requireFields(input: RecordInput): void {
  const missing = RECORD_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof RecordInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `record action "${input.action}" requires ${list}, which ${
      missing.length === 1 ? "was" : "were"
    } not supplied. Resend the call with ${list} set.`,
    { fields: missing },
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const record = defineOperation({
  name: "record",
  kind: "write",
  summary:
    "Puts something on an item's record — say which with action. checkpoint is your resume point and NEEDS A LIVE ASSIGNMENT, refusing with conflict when you hold none. note is a plain remark and needs no assignment at all, which makes it the right call for a dispatched agent that was never assigned. artifact records a produced thing — a plan, a review, a commit, a check run — under artifactKind. blocked_on_tool reports a tool you could not use for work the item asked of you.",
  contract: {
    rules: [
      {
        fields: ["action", "sessionId"],
        rule: 'action "checkpoint" requires a LIVE ASSIGNMENT held by the sessionId you pass, and is refused with `conflict` when there is none — a checkpoint is recorded per AGENT, so it must have an assignment to attribute to. action "note" requires no assignment at all, and is the right call for a dispatched agent that was never assigned, or for anyone recording alongside the holder. This is the one asymmetry between the two and it is the most common way this tool is got wrong: reach for note unless you are the one holding the item.',
      },
      {
        fields: ["action", "body"],
        rule: 'body means something different per action. On "checkpoint" it is what you tried, what you ruled out and what is next. On "note" it is the remark. On "artifact" it is the artifact\'s text — except for a pull_request or check_run, where it must be a STATUS from a fixed list rather than prose. On "blocked_on_tool" it is not used at all; say what happened in `needed` and `refusal`.',
      },
      {
        fields: ["artifactKind"],
        rule: 'The artifact kind is `artifactKind`, not `kind` — `kind` means something else on the loop tool, and one word with two meanings on adjacent tools is a guess rather than a name. Required by action "artifact" and accepted by no other action.',
      },
    ],
    example: {
      action: "note",
      itemId: "b1f0c3d2-0000-4000-8000-000000000000",
      body: "Reproduced the refusal against a scratch database. It is the assignment lookup, not the schema.",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: RecordInput): Promise<unknown> {
    // Before the required-field check, so a call carrying a foreign field is
    // told about the foreign field rather than about whatever it was
    // mistaken for — a `note` sent with `findings` and no `body` should
    // hear about `findings` first, since that is the mistake that would
    // otherwise have been swallowed.
    rejectForeignFields("record", input.action, input, FORWARDING);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()`
    // schema accepts, and forwards each as it arrived — absent stays
    // absent, so every default belongs to the operation that declares it.
    // A field this tool accepts that the chosen delegate does not is
    // refused by that delegate's own parse, naming itself, which is why no
    // per-action allow-list is repeated here.
    switch (input.action) {
      case "checkpoint":
        return checkpoint.handler(
          ctx,
          parseDelegateInput(
            checkpoint.name,
            checkpoint.input,
            {
              itemId: input.itemId,
              sessionId: input.sessionId,
              body: input.body,
              ...(input.headline === undefined ? {} : { headline: input.headline }),
            },
            ctx.caller.transport,
          ),
        );
      case "note":
        return note.handler(
          ctx,
          parseDelegateInput(
            note.name,
            note.input,
            {
              itemId: input.itemId,
              body: input.body,
              ...(input.actorType === undefined ? {} : { actorType: input.actorType }),
              ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            },
            ctx.caller.transport,
          ),
        );
      case "artifact":
        return recordArtifact.handler(
          ctx,
          parseDelegateInput(
            recordArtifact.name,
            recordArtifact.input,
            {
              itemId: input.itemId,
              artifactKind: input.artifactKind,
              ...(input.body === undefined ? {} : { body: input.body }),
              ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
              ...(input.reviewRound === undefined ? {} : { reviewRound: input.reviewRound }),
              ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
              ...(input.supersedesSha === undefined ? {} : { supersedesSha: input.supersedesSha }),
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              ...(input.browserSession === undefined
                ? {}
                : { browserSession: input.browserSession }),
              ...(input.followUpItemId === undefined
                ? {}
                : { followUpItemId: input.followUpItemId }),
              ...(input.createdByType === undefined ? {} : { createdByType: input.createdByType }),
              ...(input.createdById === undefined ? {} : { createdById: input.createdById }),
              ...(input.findings === undefined ? {} : { findings: input.findings }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            },
            ctx.caller.transport,
          ),
        );
      case "blocked_on_tool":
        return reportBlockedOnTool.handler(
          ctx,
          parseDelegateInput(
            reportBlockedOnTool.name,
            reportBlockedOnTool.input,
            {
              itemId: input.itemId,
              tool: input.tool,
              needed: input.needed,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
