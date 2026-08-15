// `register_session` — SCHEMA.md §21, `POST /sessions/{id}/register`:
// "Handshake. Reports the hook variant and its protocol version; the
// transport the registration arrived over is stamped by the adapter and
// decides which hook variant the reply describes. The reply says what to
// update, and whether the session may claim."
//
// ── The transport is not in the input schema, and that is the point ─────
//
// §21 makes the registration transport a *capability signal*: registering
// over the command line proves the command line is installed and the
// database is reachable; registering over MCP or HTTP proves a server is
// reachable. A signal a caller can supply proves nothing at all — a session
// could claim to have arrived over a transport it did not, and the whole
// mechanism would be a field the client fills in about itself. So it is read
// off `ctx.caller.transport`, which every adapter stamps and no operation
// guesses, and a call arriving with no stamped transport is refused rather
// than defaulted.
//
// **`.strict()` does the enforcing.** A payload carrying `transport` is not
// silently ignored, it is rejected with `invalid_input` naming the field —
// which is the difference between a client that learns it is doing something
// meaningless and one that keeps sending a field nobody reads.
//
// ── Upsert, not insert ─────────────────────────────────────────────────
//
// A session registers "before it does anything", and a long session may do
// that more than once — after an update, after a reconnect, or simply
// because the launcher re-runs the handshake. A second registration is a
// refresh, not a conflict: it stamps `lastSeenAt`, and it may legitimately
// report a *different* version than the first (the point of updating). What
// it must not do is reset `registeredAt`, so that "when did this session
// first appear" survives.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  assessVersion,
  isSessionTransport,
  resolveVariant,
  transportToStored,
  type SessionTransport,
  type VersionAssessment,
} from "@/lib/sessions";
import { surfaceForTransport } from "@/lib/surfaces";
import { HOOK_VARIANTS, HOOK_PROTOCOL } from "@/lib/build-constants";
import { ensureNameForSession } from "@/lib/agent-names";

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
    machine: z.string().min(1),
    /**
     * The variant the session wants, overriding the one its transport
     * implies. Optional because the ordinary registration names none and
     * takes what the transport gives it.
     */
    hookVariant: z.enum(HOOK_VARIANTS).optional(),
    /**
     * The protocol version the session's hook speaks. An integer, and
     * non-negative: it is compared, never parsed, and a version below zero
     * is not a version this build could ever have published.
     */
    hookVersion: z.number().int().min(0).optional(),
    /** What kind of agent tool it is, as it describes itself. */
    client: z.string().min(1).optional(),
    personId: z.string().min(1).optional(),
  })
  .strict();

export type RegisterSessionInput = z.infer<typeof inputSchema>;

export interface RegisterSessionOutput {
  readonly sessionId: string;
  readonly machine: string;
  /** The transport the adapter stamped — what the session actually arrived over. */
  readonly transport: SessionTransport;
  /** The hook variant this session should install. */
  readonly hookVariant: string;
  /** Whether the payload overrode the variant the transport implied. */
  readonly hookVariantOverridden: boolean;
  readonly hookVersion: number | null;
  /**
   * The name of the hook the reply is describing.
   *
   * A transport-specific reply is the whole point of the handshake: a
   * session that registered over the command line is told about the
   * command-line hook, and one that registered over HTTP is told about the
   * HTTP hook. Naming it explicitly — rather than leaving the caller to
   * derive it from `hookVariant` — means an installer has a string to act on
   * instead of a mapping to reimplement.
   */
  readonly hook: string;
  /** What this build speaks and the oldest it accepts, for this session's variant. */
  readonly protocol: { readonly current: number; readonly minSupported: number };
  readonly version: VersionAssessment;
  /**
   * Whether this session may take ownership of an item — resolved against
   * `hook.require_registration_to_claim`, not just the version verdict.
   *
   * `assessVersion` only ever compares versions; it has no idea the setting
   * exists, because it is the pure half of §21 and the setting is a policy
   * choice, not a fact about a protocol number. `assertSessionMayClaim`
   * (`session-registration.ts`) is what a real claim actually consults, and
   * with the setting off (the shipped default) it returns `undefined`
   * immediately — every session may claim regardless of what it reported
   * here, including one that reported nothing at all. Echoing
   * `version.mayClaim` unconditionally would tell a session it may not claim
   * in exactly that case, when a claim would in fact succeed: the handshake
   * would be recommending the one dishonest way through the gate this
   * setting exists to close. So this field mirrors the setting first and the
   * version verdict only when the setting is on — the same two-step
   * `assertSessionMayClaim` performs.
   */
  readonly mayClaim: boolean;
  /**
   * The crew name this session is now known by, assigned server-side as
   * part of registering — never requested separately (§9, §18). `null`
   * when the roster is exhausted: registration still succeeds, because
   * naming is a courtesy that rides on a call the session had to make
   * anyway, not a precondition for it (see `ensureNameForSession`).
   */
  readonly crewName: string | null;
  /**
   * Where to get the hook, present only when this registration reported no
   * version at all — MILESTONES.md #125(b).
   *
   * "No version" is read the same way `assessVersion`'s `unregistered`
   * verdict reads it (`@/lib/sessions.ts`): a session that has never run the
   * hook has made no claim about what it can enforce, and *that* is the
   * session with nowhere to go without this field — one that already
   * reported a version has a hook installed and needs no fetch instructions
   * repeated at it on every re-registration. `version.verdict` is not what
   * this checks, because `advisory` and `incompatible` both describe a
   * session that reported a version below `current` — and both still
   * describe a session that already has *something* installed;
   * `hookVersion === null` is the literal fact this field exists to answer.
   *
   * Absent, not `null`, when it does not apply: a client checking
   * `"fetch" in registration` gets a clean answer either way, and omitting
   * the key is one field simpler to document than a key that is sometimes
   * an object and sometimes `null`.
   */
  readonly fetch?: {
    /**
     * Where to `GET` the built script for this session's `hookVariant` —
     * `src/app/api/hook/script/route.ts`. A path, not a full URL: the
     * service layer holds no notion of its own external address (§22 — "the
     * service never knows an HTTP status exists", and by the same boundary
     * it never knows its own host), and a caller reaching this handshake at
     * all already has the base URL it registered against, so joining the
     * two costs it nothing an absolute URL would have saved.
     */
    readonly scriptUrl: string;
    /**
     * Deliberately vague, matching the hook's own posture as a thin client
     * (DECISIONS.md): the server cannot know where a given machine keeps
     * its other hooks, so it says what the file is and what it must be
     * wired to, not a path to write it to. A wrong concrete path would be
     * worse than an honest "figure out where yours go" — it would look
     * authoritative and be wrong on most machines.
     */
    readonly install: string;
  };
}

/** The installed name of each hook variant, as row #48's installer writes it into a tool's config. */
const HOOK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  cli: "standup-hook (command-line variant)",
  http: "standup-hook (http variant)",
});

/**
 * Builds the fetch instructions for a session that reported no hook version.
 *
 * This is the route out MILESTONES.md #125(b) exists to add: without it, a
 * session told "you should be running the `http` hook" and nothing else has
 * no way to obtain one unless it already happens to hold a source checkout
 * of this repository — the dead end the row's description names directly.
 */
function fetchInstructionsFor(variant: string): RegisterSessionOutput["fetch"] {
  return {
    scriptUrl: `/api/hook/script?variant=${encodeURIComponent(variant)}`,
    install:
      "Download this to wherever your other hooks live, then wire it to PreToolUse and " +
      "PostToolUse. The server cannot know your tool's layout, so this is deliberately not a " +
      "path — it names the file and what it must be wired to, not where to put it.",
  };
}

export const registerSession = defineOperation({
  name: "register_session",
  kind: "write",
  summary:
    "Registers a session and reports which hook variant it should run, and whether it may claim (governed by `hook.require_registration_to_claim`, off by default — not the protocol version alone).",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: RegisterSessionInput): Promise<RegisterSessionOutput> {
    const stamped = ctx.caller.transport;
    if (!isSessionTransport(stamped)) {
      // Not `not_implemented` and not `internal`: the call is well-formed
      // and the build supports it, but it arrived through a door that has
      // not been taught to stamp which door it is — which the caller cannot
      // fix by changing the payload, so the message names the adapter rather
      // than a field the caller controls.
      throw new InvalidInputError(
        `This registration arrived over a transport the server cannot identify` +
          `${stamped === undefined ? "" : ` (${stamped})`}, so it carries no capability signal. ` +
          `The adapter stamps the transport; it is never supplied by the caller.`,
        { fields: [] },
      );
    }

    const { variant, overridden } = resolveVariant(stamped, input.hookVariant);
    const hookVersion = input.hookVersion ?? null;

    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "Session" (
         "id", "machine", "transport", "hookVariant", "hookVariantOverridden",
         "hookVersion", "client", "personId", "registeredAt", "lastSeenAt"
       ) VALUES ($1, $2, $3::"SessionTransport", $4::"HookVariant", $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT ("id") DO UPDATE SET
         "machine" = EXCLUDED."machine",
         "transport" = EXCLUDED."transport",
         "hookVariant" = EXCLUDED."hookVariant",
         "hookVariantOverridden" = EXCLUDED."hookVariantOverridden",
         "hookVersion" = EXCLUDED."hookVersion",
         "client" = EXCLUDED."client",
         "personId" = EXCLUDED."personId",
         "lastSeenAt" = NOW()`,
      input.sessionId,
      input.machine,
      transportToStored(stamped),
      variant,
      overridden,
      hookVersion,
      input.client ?? null,
      input.personId ?? null,
    );

    // `stamped` rather than `ctx.caller.transport`: this operation has
    // already resolved the transport it was reached over, and that resolved
    // value is the one the rest of the reply is built from — wording the
    // message off a second reading of the same fact would be a way for the
    // two to disagree.
    const version = assessVersion({
      variant,
      reportedVersion: hookVersion,
      surface: surfaceForTransport(stamped),
    });

    // Named here, not requested separately (§9, §18): this is the call every
    // session makes once, before anything else, so it is where the server
    // assigns identity. `ensureNameForSession` keeps a re-registering
    // session's existing name rather than drawing a second one — see that
    // function's own comment for why a second draw would orphan the first.
    const crewNameRow = await ensureNameForSession(ctx.db, input.sessionId);

    // Mirrors `assertSessionMayClaim` (`../session-registration.ts`): off,
    // the setting is the whole answer — a claim will succeed regardless of
    // what this session reported, so the handshake must say so rather than
    // repeat the version verdict on its own. On, the version verdict is the
    // answer, exactly as the claim path applies it.
    const requireRegistration = ctx.settings.values["hook.require_registration_to_claim"] === true;
    const mayClaim = requireRegistration ? version.mayClaim : true;

    return {
      sessionId: input.sessionId,
      machine: input.machine,
      transport: stamped,
      hookVariant: variant,
      hookVariantOverridden: overridden,
      hookVersion,
      hook: HOOK_NAMES[variant] ?? variant,
      protocol: {
        current: HOOK_PROTOCOL[variant].current,
        minSupported: HOOK_PROTOCOL[variant].minSupported,
      },
      version,
      mayClaim,
      crewName: crewNameRow?.name ?? null,
      ...(hookVersion === null ? { fetch: fetchInstructionsFor(variant) } : {}),
    };
  },
});
