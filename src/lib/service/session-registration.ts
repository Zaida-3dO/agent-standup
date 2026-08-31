// The claim-side half of §21: **no unguarded session holds work — where
// `hook.require_registration_to_claim` is on.** (Off, the shipped default,
// is covered further down.)
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
import { surfaceForTransport } from "@/lib/surfaces";
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
 * ── The setting, and why it defaults to OFF ────────────────────────────
 *
 * `hook.require_registration_to_claim` turns this on, and it defaults to
 * **off**.
 *
 * The version is *information*, not permission. What it tells the server is
 * which signals to expect: a session running the hook reports its tool
 * calls, so silence from it means something; a session running no hook
 * reports nothing, so silence from it means nothing at all. Both facts are
 * useful and neither is a reason to refuse the session work.
 *
 * Defaulting to enforcement made ownership unreachable for an honest
 * caller. Claiming required a version, registering a version truthfully
 * required running the hook, and a session with no hook had no way to
 * obtain one — so the only route through was to assert a version it did not
 * run, which is precisely the false claim this check exists to catch. A gate
 * whose only exit is a lie is not protecting anything.
 *
 * Off, the rest of the product is unchanged for such a session: it mints,
 * transitions, records artifacts, requests reviews, checkpoints and claims.
 * The single thing it loses is enforcement, because there is nothing there
 * to enforce with.
 *
 * **Nothing compensates for that loss, and saying so plainly is the honest
 * statement.** The obvious compensation — surfacing the session as unhooked
 * wherever its work is read, so a reader can tell "no rule fired" apart from
 * "no rule could fire" — is an intended follow-up and **is not built**.
 * Nothing writes that state and nothing reads it. The `Session` row carries
 * the raw material (`hookVersion` is null for a session that named none), so
 * it is a display and propagation problem rather than a schema one; until
 * something does it, the accurate claim is that the difference is invisible
 * downstream.
 *
 * On, ownership is restricted to sessions whose rules this build can expect
 * — the right posture for an installation that has finished rolling the hook
 * out and wants to keep it that way.
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
    // The transport the adapter stamped, so the "register the session"
    // instruction names the spelling this caller has (MILESTONES.md #111).
    // Read from the caller rather than from the stored row on purpose: the
    // row records the surface a previous registration came over, and the
    // reader of this refusal is on whatever surface they are on *now*.
    surface: surfaceForTransport(ctx.caller.transport),
  });

  if (assessment.versionPermitsClaim) return;

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
