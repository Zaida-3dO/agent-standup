// Session registration and the version rule — SCHEMA.md §21.
//
// A session registers before it does anything, and **the transport it
// registers over is a capability signal**: registering over the command line
// proves the command line is installed and the database is reachable;
// registering over MCP or HTTP proves a server is reachable. So the
// transport — stamped by the adapter, never supplied by the caller — decides
// which hook variant the reply describes.
//
// This module is the pure half of that: the vocabulary, the derivation, and
// the comparison. It touches no database and holds no client. The operation
// that writes a row (`service/operations/register-session.ts`) and the check
// that refuses a claim (`service/session-registration.ts`) both call in here, so
// there is exactly one implementation of "what does this reported version
// mean" — two would be two things that can disagree about whether a session
// is allowed to hold work, and the disagreement would be invisible until one
// of them let something through.

import {
  HOOK_PROTOCOL,
  isHookVariant,
  type HookVariant,
  type ProtocolRange,
} from "./build-constants";

export type { HookVariant };

/**
 * The five transports a session can register over (SCHEMA.md §21).
 *
 * **Five values, not two, and not three.** The version rule turns on the
 * *binding*, so `cli-direct` and `cli-http` are different answers even though
 * both are "the command line": one is the app itself, with the hook, the
 * rules and the migrations in a single installed package, and the other is a
 * command line shelling out to a server it does not share a version with.
 * Collapsing them would erase exactly the distinction §21's "one case
 * collapses" paragraph turns on.
 *
 * Hyphenated on the wire because these are the names the conformance drivers
 * use and the names a person types; the database stores the underscored
 * spelling because a Prisma enum member cannot contain a hyphen. `toStored`
 * and `fromStored` below are the only two places that translation happens.
 */
export const SESSION_TRANSPORTS = [
  "cli-direct",
  "cli-http",
  "mcp-stdio",
  "mcp-http",
  "http",
] as const;

export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];

export function isSessionTransport(value: unknown): value is SessionTransport {
  return typeof value === "string" && (SESSION_TRANSPORTS as readonly string[]).includes(value);
}

/** The wire name as the database stores it. */
export function transportToStored(transport: SessionTransport): string {
  return transport.replace("-", "_");
}

/** The database's spelling back to the wire name, or `undefined` for a value nothing registered. */
export function transportFromStored(stored: string): SessionTransport | undefined {
  const wire = stored.replace("_", "-");
  return isSessionTransport(wire) ? wire : undefined;
}

/**
 * Which hook variant a transport implies.
 *
 * The two command-line bindings get the command-line hook; everything
 * reached over a server gets the HTTP hook. This is a total function over
 * the five transports on purpose — a transport with no mapping would be a
 * session the server could register and then have nothing to tell, which is
 * a registration that accomplished nothing.
 */
export function variantForTransport(transport: SessionTransport): HookVariant {
  return transport === "cli-direct" || transport === "cli-http" ? "cli" : "http";
}

/**
 * What the version comparison concluded (SCHEMA.md §21, "Versions, and what
 * each answer does").
 *
 * Four outcomes rather than a boolean, because "nothing to say", "you should
 * update", "I cannot talk to you" and "I have never heard of you" are four
 * different things to tell a session, and three of them are actionable in
 * different ways.
 */
export const VERSION_VERDICTS = ["current", "advisory", "incompatible", "unregistered"] as const;
export type VersionVerdict = (typeof VERSION_VERDICTS)[number];

export interface VersionAssessment {
  readonly verdict: VersionVerdict;
  /** Whether this session may take ownership of an item. */
  readonly mayClaim: boolean;
  /** A sentence naming the cause, written for whoever has to act on it. */
  readonly message: string;
  /** The variant the comparison was made against, when there was one. */
  readonly variant?: HookVariant;
  /** What this build speaks and the oldest it accepts, for the variant above. */
  readonly protocol?: ProtocolRange;
}

export interface AssessVersionInput {
  /** The variant to compare against. `undefined` when the session never registered. */
  readonly variant?: HookVariant | undefined;
  /** The version the session reported. `undefined` or `null` = never reported one. */
  readonly reportedVersion?: number | null | undefined;
  /** The build's ranges. A parameter so a test can drive the boundaries without editing the build. */
  readonly protocols?: Readonly<Record<HookVariant, ProtocolRange>>;
}

/**
 * Compares one session's reported hook version against this build's range
 * for that session's variant.
 *
 * ── Why below-`current` is advisory and below-`min_supported` is not ────
 *
 * A fix must not disable every session the moment it deploys. If any version
 * bump refused, then every release would be a mandatory reinstall on every
 * machine simultaneously, which is precisely the outage a version scheme is
 * supposed to prevent. So the ordinary bump nudges. Anything that genuinely
 * *must* be enforced is expressed by raising `min_supported`, which is a
 * deliberate act taken once in a release, by someone who has decided that
 * the older protocol is not merely old but wrong.
 *
 * ── Why an absent registration refuses rather than nudges ───────────────
 *
 * A session that never registered has made no claim at all about what it can
 * enforce. That is not the same as an old claim — it is the absence of one,
 * and the honest reading of "I do not know whether this session is guarded"
 * is not "assume it is". It refuses on the same fail-closed rule the hook
 * itself uses.
 *
 * ── Why a version above `current` is fine ───────────────────────────────
 *
 * A session running a *newer* hook than this server is not a problem this
 * server can do anything about, and refusing it would mean a rolling upgrade
 * could never put a new client in front of an old server. `current` is what
 * this build speaks, not a ceiling on what it will talk to.
 */
export function assessVersion({
  variant,
  reportedVersion,
  protocols = HOOK_PROTOCOL,
}: AssessVersionInput): VersionAssessment {
  // Never registered, or registered without naming a version — which is the
  // same fact for this purpose: no claim was made about what this session
  // can enforce.
  if (variant === undefined || reportedVersion === undefined || reportedVersion === null) {
    return {
      verdict: "unregistered",
      mayClaim: false,
      message:
        "This session has not registered a hook protocol version, so the server cannot tell " +
        "whether the rules it would enforce are the rules this build expects. Register the " +
        "session with `standup session register` before claiming an item.",
    };
  }

  const protocol = protocols[variant];

  if (reportedVersion < protocol.minSupported) {
    return {
      verdict: "incompatible",
      mayClaim: false,
      variant,
      protocol,
      message:
        `This session reported ${variant} hook protocol version ${reportedVersion}, and this ` +
        `build's oldest supported ${variant} version is ${protocol.minSupported}. The rules it ` +
        `would enforce are not the rules this build expects, so it may not take ownership of an ` +
        `item. Update the hook to version ${protocol.current}, then re-register.`,
    };
  }

  if (reportedVersion < protocol.current) {
    return {
      verdict: "advisory",
      mayClaim: true,
      variant,
      protocol,
      message:
        `This session's ${variant} hook is at protocol version ${reportedVersion}; this build ` +
        `speaks ${protocol.current}. It is still supported (the oldest accepted is ` +
        `${protocol.minSupported}), so nothing is blocked — but update when convenient.`,
    };
  }

  return {
    verdict: "current",
    mayClaim: true,
    variant,
    protocol,
    message: `This session's ${variant} hook is up to date.`,
  };
}

/**
 * A registration, as `register_session` resolves it and the reply describes
 * it.
 *
 * `transport` is separate from `hookVariant` because they answer different
 * questions and only one of them is overridable: the transport is a fact the
 * adapter observed, the variant is a conclusion drawn from it that the caller
 * may correct (a session reached over HTTP that has the command line
 * installed and wants the command-line hook). Recording both means the
 * override is visible afterwards rather than having silently replaced the
 * observation.
 */
export interface ResolvedRegistration {
  readonly sessionId: string;
  readonly machine: string;
  readonly transport: SessionTransport;
  readonly hookVariant: HookVariant;
  readonly hookVariantOverridden: boolean;
  readonly hookVersion: number | null;
  readonly client: string | null;
  readonly personId: string | null;
}

/**
 * Resolves the variant for a registration.
 *
 * "With both available the registration transport wins; an explicit override
 * in the payload is honoured and recorded as an override" (§21) — so the
 * transport is the default and the payload is the exception, never the other
 * way round. An override naming the variant the transport would have chosen
 * anyway is *not* recorded as an override: it changed nothing, and recording
 * it would make "this session's variant was overridden" mean "the caller
 * mentioned it", which is not a fact anyone can act on.
 */
export function resolveVariant(
  transport: SessionTransport,
  requested: unknown,
): { readonly variant: HookVariant; readonly overridden: boolean } {
  const derived = variantForTransport(transport);
  if (!isHookVariant(requested)) return { variant: derived, overridden: false };
  return { variant: requested, overridden: requested !== derived };
}
