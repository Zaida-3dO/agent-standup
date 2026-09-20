// `session` — registering a session and reading its shape, behind one tool.
//
// ── Why this is folded, and why only on MCP ─────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. These two
// verbs are the same subject seen twice: `register_session` tells the server
// what this session is, and `get_session_shape` asks what a session has been
// doing. A caller reaching for either has already decided it is working with
// a session.
//
// Both operations are **not removed**. They stay registered, stay reachable
// over HTTP and the command line (`standup session register`, `standup
// session shape`), and keep their own tests; they are waived off the two MCP
// adapters only.
//
// ── Why `claim` and `release` are NOT actions here ──────────────────────
//
// They are ownership verbs that happen to take a session id, not statements
// about the session itself — and they carry their own guards, their own
// lease semantics and their own refusals. Folding them in would put the
// ownership model behind a tool named after the thing it takes as a
// parameter, which is the grammar mistake this compaction is removing
// elsewhere rather than adding here.
//
// ── No second implementation ────────────────────────────────────────────
//
// Both actions dispatch to the operation that already implements them,
// through the same `ctx` they were handed. A refusal a caller gets here is
// the *same object* the unfolded operation would have thrown, so its `code`,
// its `guard` id and its `fields` are identical on both surfaces.
//
// ── The field that decides whether a caller may claim ───────────────────
//
// `register` answers with `mayClaim`, resolved against the
// `hook.require_registration_to_claim` setting. That resolution lives in
// `register_session` and is not restated here: a fold that recomputed it
// from the protocol version alone would report a different answer from the
// operation it claims to reproduce, which is the drift the no-second-
// implementation rule exists to prevent.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { rejectForeignFields, type FoldForwarding } from "../foreign-fields";
import { registerSession } from "./register-session";
import { getSessionShape } from "./get-session-shape";

/** The verbs this tool folds. */
export const SESSION_ACTIONS = ["register", "shape"] as const;

export type SessionAction = (typeof SESSION_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is made
 * from, so a required field and the sentence naming it cannot disagree.
 *
 * `sessionId` is required by both, but for different reasons: `register`
 * cannot register a session with no subject, and `shape` reads a session
 * someone names. `machine` is required by `register` alone.
 */
export const SESSION_ACTION_FIELDS: Readonly<
  Record<SessionAction, { required: readonly string[] }>
> = Object.freeze({
  register: { required: ["sessionId", "machine"] },
  shape: { required: ["sessionId"] },
});

const inputSchema = z
  .object({
    /** Which verb. The one field that decides what the rest of the call means. */
    action: z.enum(SESSION_ACTIONS),
    /** The session being registered, or the session being read. */
    sessionId: z.string().min(1).optional(),

    // ── `register` ─────────────────────────────────────────────────────
    /** The machine this session is running on. */
    machine: z.string().min(1).optional(),
    /**
     * Which hook variant is installed, and at what version.
     *
     * Left loose here and parsed by `register_session`'s own schema, which
     * is where the variant enum lives. Restating it would put one list in
     * two places.
     */
    hookVariant: z.string().min(1).optional(),
    hookVersion: z.number().int().min(0).optional(),
    client: z.string().min(1).optional(),
    personId: z.string().min(1).optional(),
    driveMode: z.enum(["autonomous", "supervised", "manual"]).optional(),

    // ── `shape` ────────────────────────────────────────────────────────
    /** How far back to read. Bounded by the operation. */
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type SessionInput = z.infer<typeof inputSchema>;

/** Refuses an action that is missing a field it cannot run without. */
/**
 * Which delegate each action forwards to, for the foreign-field guard.
 *
 * Derived rather than listed: the fields `register` may carry ARE the
 * fields `register_session` declares. `shape` takes `sessionId` and
 * `limit` and nothing else, so the six registration fields are refused on
 * it rather than accepted and dropped — a caller re-registering while
 * asking for a shape would otherwise get a shape and no registration, with
 * nothing said about it.
 */
export const FORWARDING: FoldForwarding<SessionAction> = Object.freeze({
  register: { schema: registerSession.input },
  shape: { schema: getSessionShape.input },
});

function requireFields(input: SessionInput): void {
  const missing = SESSION_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof SessionInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `session action "${input.action}" requires ${list}, which ${
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
export const session = defineOperation({
  name: "session",
  kind: "write",
  summary:
    "Works with this session — say which with action. register declares the session and the machine it runs on, and answers with the hook to install and whether it may claim (the hook.require_registration_to_claim setting decides that, not the protocol version alone). shape reports what a named session has been calling and how much, which is what decides whether a session-shaped guard applies to it.",
  contract: {
    rules: [
      {
        fields: ["action"],
        rule: "register requires sessionId and machine; shape requires sessionId. A missing field is refused by name.",
      },
      {
        fields: ["sessionId"],
        rule: "On action register this is the session being declared — itself. On action shape it is the session being ASKED ABOUT, which is not always the caller: a session may read another's shape.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: SessionInput): Promise<unknown> {
    rejectForeignFields("session", input.action, input, FORWARDING);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()` schema
    // accepts, and forwards each as it arrived — absent stays absent, so
    // every default belongs to the operation that declares it.
    switch (input.action) {
      case "register":
        return registerSession.handler(
          ctx,
          parseDelegateInput(
            registerSession.name,
            registerSession.input,
            {
              sessionId: input.sessionId,
              machine: input.machine,
              ...(input.hookVariant === undefined ? {} : { hookVariant: input.hookVariant }),
              ...(input.hookVersion === undefined ? {} : { hookVersion: input.hookVersion }),
              ...(input.client === undefined ? {} : { client: input.client }),
              ...(input.personId === undefined ? {} : { personId: input.personId }),
              ...(input.driveMode === undefined ? {} : { driveMode: input.driveMode }),
            },
            ctx.caller.transport,
          ),
        );
      case "shape":
        return getSessionShape.handler(
          ctx,
          parseDelegateInput(
            getSessionShape.name,
            getSessionShape.input,
            {
              sessionId: input.sessionId,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
