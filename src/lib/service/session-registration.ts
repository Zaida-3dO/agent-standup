// The claim-side half of §21: **no unguarded session holds work.**
//
// ── Why this refuses the claim rather than everything ───────────────────
//
// A hook can always be not installed. Its presence cannot be enforced on a
// machine the server does not control, and a rule that pretends otherwise is
// a rule that is wrong on exactly the machines it matters on. What *can* be
// enforced, in the service layer and therefore through every adapter, is
// that a session which cannot enforce this build's rules does not take
// ownership of work under them. Such a session may still read, orient, and
// update itself — none of those are ownership — but it may not claim.
//
// **That is the honest maximum, and stating it as the maximum matters.** A
// blanket refusal would be trivially bypassed (do not install the hook, do
// not register, and the server never hears from you at all), so it would buy
// nothing while breaking every read.
//
// ── Why this lives here and not in `guards/` ────────────────────────────
//
// `service/guards/` is the state-machine's guard registry — those guards
// answer "may this item move from A to B", are keyed by transition, and are
// consulted by `transition_item`. This is not a transition question: it is a
// fact about the *caller*, checked on one operation that has no state
// machine in it at all. Registering it as a transition guard would mean
// declaring a transition it applies to, and there isn't one.

import { ForbiddenError } from "./errors";
import type { ServiceContext } from "./context";
import { assessVersion, transportFromStored, variantForTransport } from "@/lib/sessions";
import { isHookVariant, type HookVariant } from "@/lib/build-constants";

/** The rule identifier, so a refusal is attributable without parsing its message. */
export const SESSION_REGISTRATION_RULE = "session_registered_and_compatible";

interface SessionRow {
  readonly hookVariant: string | null;
  readonly hookVersion: number | null;
  readonly transport: string;
}

/**
 * Refuses a claim by a session that is not registered, or whose hook is
 * below this build's minimum for its variant.
 *
 * ── The three refusals, and why each is a refusal ───────────────────────
 *
 *   - **No row at all.** The session never registered. Nothing is known
 *     about what it can enforce, and "I do not know" is not "it is fine".
 *   - **A row with no version.** It registered but named no version. Same
 *     conclusion: a registration that makes no claim about the protocol is
 *     not a claim about the protocol. Treating it as current would make the
 *     whole comparison optional by omission.
 *   - **A version below `min_supported`.** It named a version this build has
 *     decided is not merely old but wrong, in the deliberate act of raising
 *     the minimum in a release.
 *
 * **An advisory version does not refuse.** That is the entire difference
 * between `current` and `min_supported`: a fix must not disable every
 * session the moment it deploys. The nudge goes back on the handshake and on
 * the next hook call; the claim proceeds.
 *
 * ── The setting, and why it defaults to enforcing ──────────────────────
 *
 * `hook.require_registration_to_claim` turns this off. It defaults to
 * **on**, because a rule that ships off is a rule nobody has run: the
 * refusals below would never have fired against a real installation, and the
 * first time anyone found out whether they worked would be the day someone
 * turned it on. It exists because an installation whose sessions cannot yet
 * register should be *degraded* rather than stopped — the escape hatch is for
 * the deployment that discovers its clients are older than its server, and
 * it is marked `sensitive` because turning it off lets work be held under
 * rules the holder cannot enforce, which is the one thing this rule prevents.
 */
export async function assertSessionMayClaim(ctx: ServiceContext, sessionId: string): Promise<void> {
  if (ctx.settings.values["hook.require_registration_to_claim"] !== true) return;

  const rows = await ctx.db.$queryRawUnsafe<SessionRow[]>(
    `SELECT "hookVariant"::text AS "hookVariant", "hookVersion", "transport"::text AS "transport"
       FROM "Session" WHERE "id" = $1`,
    sessionId,
  );

  const row = rows[0];
  const variant = row === undefined ? undefined : resolveStoredVariant(row);
  const assessment = assessVersion({
    variant,
    reportedVersion: row?.hookVersion ?? null,
  });

  if (assessment.mayClaim) return;

  throw new ForbiddenError(`${assessment.message} (session ${sessionId})`, {
    fields: ["sessionId"],
    details: {
      rule: SESSION_REGISTRATION_RULE,
      verdict: assessment.verdict,
      ...(assessment.variant === undefined ? {} : { hookVariant: assessment.variant }),
      ...(assessment.protocol === undefined
        ? {}
        : {
            protocolCurrent: assessment.protocol.current,
            protocolMinSupported: assessment.protocol.minSupported,
          }),
    },
  });
}

/**
 * The variant to compare a stored row against.
 *
 * `hookVariant` is the answer when the row has one. When it does not — a row
 * written before a variant was recorded, or one whose variant column is null
 * — the transport still implies one, and deriving it is strictly better than
 * treating the row as unregistered: the session *did* register, and the
 * server *does* know which hook that transport gets. Returning `undefined`
 * here only when the transport is also unreadable keeps the "never
 * registered" verdict meaning what it says.
 */
function resolveStoredVariant(row: SessionRow): HookVariant | undefined {
  if (isHookVariant(row.hookVariant)) return row.hookVariant;
  const transport = transportFromStored(row.transport);
  return transport === undefined ? undefined : variantForTransport(transport);
}
