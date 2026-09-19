// Resolving a claim's identity from a lease key, the legacy fields, or
// both — and refusing when it has neither.
//
// This is where acceptance criteria 2 and 3 actually live. The key module
// next door only encodes and decodes; this one decides what a *call* meant.
//
// ── The three inputs and the four cases ─────────────────────────────────
//
// A caller arrives with a `leaseKey`, with the legacy fields
// (`rootSessionId` + `sessionId` + `holderType` + `holderId`), with both,
// or with neither:
//
//   - **Key only** — the intended shape. Decode it; the four fields are
//     implicit in it and nothing else is consulted.
//   - **Legacy only** — still works, unchanged, for the whole deprecation
//     window. The response carries a `leaseKey` and a `leaseKeyDeprecation`
//     sentence, so a caller learns the new shape from the call it already
//     makes rather than from a document it has no reason to open. That is
//     the same principle `rootSessionWarning` established.
//   - **Both** — accepted only when they AGREE, and refused by name when
//     they do not. Silently preferring one would make the other field a
//     decoration that some readers trust; and of the two possible silent
//     choices, each is the wrong one in some real scenario. A disagreement
//     is a genuine ambiguity about who is claiming, and the caller is the
//     only party who can resolve it.
//   - **Neither** — REFUSED. The tempting alternative is to resolve it to
//     "I am the root of my own crew", which for a dispatched agent is
//     always wrong and never visible in the result.
//
// ── Why the absent case refuses rather than warns ───────────────────────
//
// `1e469146` shipped a *warning* for an unknown `rootSessionId` and scoped
// out refusing a mismatch, and that reasoning still holds for the case it
// covered: a root session that has legitimately ended is indistinguishable
// from a typo, so refusing it would break a working flow to catch a
// mistake. **Absence is not that case.** An absent key is not an ambiguous
// value; it is no value at all, and there is no legitimate flow it breaks
// that cannot state its own identity instead. So the two decisions are
// consistent rather than in tension: an ambiguous value warns, a missing
// one refuses.
import { GuardRejectedError } from "./service/errors";
import {
  LEASE_KEY_PREFIX,
  LeaseKeyError,
  decodeLeaseKey,
  encodeLeaseKey,
  looksLikeLeaseKey,
  type LeaseIdentity,
} from "./lease-key";
import type { HolderType } from "./claims";

/** The guard identifier an unusable or absent lease key rejects under. */
export const LEASE_KEY_GUARD = "claims.lease_key_required";

/** The guard identifier a key that contradicts its legacy fields rejects under. */
export const LEASE_KEY_CONFLICT_GUARD = "claims.lease_key_disagrees";

/** What a caller supplied, before we decide what it meant. */
export interface LeaseResolutionInput {
  readonly leaseKey?: string | null;
  readonly rootSessionId?: string | null;
  readonly sessionId?: string | null;
  readonly holderType?: string | null;
  readonly holderId?: string | null;
}

/** What the call resolved to, and how. */
export interface ResolvedLease {
  readonly identity: LeaseIdentity;
  /** The key for this identity — issued back on every response. */
  readonly leaseKey: string;
  /**
   * Which input decided it. `legacy` is what a caller needs to see to know
   * it is on the deprecated path; the other two are recorded for tests and
   * for anyone reading a response closely.
   */
  readonly source: "lease_key" | "legacy" | "both";
  /**
   * The root the caller actually NAMED, as distinct from the one that was
   * resolved — `null` exactly when the legacy path defaulted it to the
   * caller's own session.
   *
   * The distinction exists for `rootSessionWarning`, which is about a value
   * a caller typed and may have mistyped. Warning that a *defaulted* root
   * names no known session would be reporting our own arithmetic back as
   * the caller's error, on the one path where the deprecation notice
   * already says something more useful.
   */
  readonly statedRootSessionId: string | null;
  /**
   * The sentence telling a legacy caller what to do instead — `null` when
   * the caller already passed a key.
   *
   * **In the response rather than in a document**, which AC3 asks for
   * specifically: a deprecation nobody reads is a deprecation that does not
   * happen, and the caller is already looking at this object.
   */
  readonly leaseKeyDeprecation: string | null;
}

/**
 * The sentence said when a call carries no identity at all.
 *
 * Written to answer the two questions a refused caller actually has —
 * *what do I pass* and *where do I get it* — because this refusal will most
 * often be read by a dispatched agent that was never told either. Naming
 * the legacy fields as a fallback is deliberate: during the window they
 * still work, and a refusal that hid that would push a caller into a
 * rewrite it does not yet need.
 *
 * ── Why registration is NOT named as a source ───────────────────────────
 *
 * **`session {action: "register"}` returns no `leaseKey`** — its output
 * object carries no such field. So it must never be named here as a place
 * to get one: a caller following that instruction literally would arrive
 * back at this same refusal having learnt nothing, and a refusal whose
 * primary remedy is a dead end is worse than a blunter one, because it
 * spends the caller's next call proving the message wrong.
 *
 * The tempting repair is to make registration issue a key. It must not,
 * and the reason is the same one the key exists for: a registering session
 * is not yet a holder, so the only key registration could mint is one
 * rooted at *itself*. That is the right key for exactly one caller — an
 * orchestrator rooting its own crew — and the wrong one for the caller who
 * reads this message most, a dispatched agent. Issuing it would restore
 * the silent self-rooting default `resolveLease` refuses, one call
 * earlier and wearing the server's authority.
 *
 * So the sources named here are the two that can actually produce a key:
 * a claim response, and the agent that dispatched you (whose key came from
 * its own claim response). An orchestrator with no key yet is not stuck —
 * it has the legacy fields below, and its first claim hands it the key for
 * every claim after.
 *
 * ── …and why that is settled but not yet final ──────────────────────────
 *
 * The argument above is correct against the proposal it answers — a key
 * from registration **indistinguishable** from a claimed one. It does not
 * answer a key that says what it is. `docs/plans/LEASE-KEY-LIFECYCLE.md` §4
 * records the decision that registration WILL issue a key carrying
 * `origin: "self_rooted"`, because the failure this whole feature exists to
 * prevent was a *silent* one, and a stamped key makes the dispatched-agent
 * mistake nameable and refusable rather than invisible.
 *
 * That decision is recorded and not yet implemented. Until it is, the
 * reasoning above is the live behaviour and this text is accurate. The row
 * that implements it must rewrite this comment in the same commit rather
 * than leaving the two to contradict each other.
 *
 * **Consequence for the legacy fields, which this message names as the
 * bootstrap:** they cannot be removed before that lands, because until it
 * does they are the ONLY way to obtain a first key. They are supported, not
 * merely tolerated, and their end condition is a trigger rather than a date
 * — see §8 of that document. Nothing here may imply they are about to stop
 * working.
 */
function absentKeyMessage(): string {
  return (
    "This claim carries no `leaseKey`, and none of the legacy identity fields either, " +
    "so there is nothing to say which crew it belongs to or who is making it. " +
    "**Pass `leaseKey`.** Where to get it: every claim response returns one, so if you were " +
    "dispatched, the agent that dispatched you has one — ask for it, exactly as you would " +
    "have asked for its `rootSessionId`. Registering a session does not issue one: a session " +
    "that has not claimed anything is not yet a holder, and the key names a holder. " +
    "If you are an orchestrator starting your own crew and so have no key to be given, make " +
    "your first claim with the legacy fields below and use the `leaseKey` it returns from then on. " +
    "During the deprecation window you may instead pass the separate fields — `sessionId`, " +
    "`holderType`, `holderId` and `rootSessionId` — and they still work, but a claim " +
    "omitting `rootSessionId` there defaults it to your own `sessionId`, which silently " +
    "declared a dispatched agent a second crew. That default is what this key removes."
  );
}

/** Turns a decode failure into a refusal that keeps the decoder's diagnosis. */
function refuseBadKey(error: LeaseKeyError): never {
  throw new GuardRejectedError(LEASE_KEY_GUARD, error.message, {
    fields: ["leaseKey"],
    details: { defect: error.defect },
  });
}

/**
 * Works out who is claiming.
 *
 * Throws `GuardRejectedError` rather than `InvalidInputError` so the
 * refusal carries a stable `guard` id that a caller — and
 * `tests/lease-key-resolution.test.ts` — can branch on by name rather than
 * by matching prose.
 */
export function resolveLease(input: LeaseResolutionInput): ResolvedLease {
  const rawKey = input.leaseKey?.trim() ?? "";
  const hasKey = rawKey.length > 0;

  // The legacy shape is only "present" when it carries enough to identify a
  // claim on its own. `sessionId` + `holderType` + `holderId` is that
  // minimum; `rootSessionId` remains optional within it, because refusing a
  // genuine root claim that omits it would break the one caller for whom
  // that default is always correct — an orchestrator rooting its own crew.
  const legacySessionId = input.sessionId?.trim() ?? "";
  const legacyHolderType = input.holderType?.trim() ?? "";
  const legacyHolderId = input.holderId?.trim() ?? "";
  const hasLegacy =
    legacySessionId.length > 0 && legacyHolderType.length > 0 && legacyHolderId.length > 0;

  if (!hasKey && !hasLegacy) {
    throw new GuardRejectedError(LEASE_KEY_GUARD, absentKeyMessage(), {
      fields: ["leaseKey", "sessionId", "holderType", "holderId"],
      details: { defect: "absent" },
    });
  }

  if (hasKey) {
    // Told apart before decoding, so a caller who pasted a session id into
    // `leaseKey` is told *that*, rather than being told about base64.
    if (!looksLikeLeaseKey(rawKey)) {
      refuseBadKey(
        new LeaseKeyError(
          "not_a_lease_key",
          `\`leaseKey\` does not start with \`${LEASE_KEY_PREFIX}.\`, so it is not a lease key. ` +
            `If that value is a session id, pass it as \`sessionId\`; a lease key comes back ` +
            `from any claim response, and from the agent that dispatched you.`,
        ),
      );
    }

    let identity: LeaseIdentity;
    try {
      identity = decodeLeaseKey(rawKey);
    } catch (error) {
      if (error instanceof LeaseKeyError) refuseBadKey(error);
      throw error;
    }

    if (hasLegacy) {
      assertLegacyAgrees(identity, {
        sessionId: legacySessionId,
        holderType: legacyHolderType,
        holderId: legacyHolderId,
        rootSessionId: input.rootSessionId?.trim() || null,
      });
      return {
        identity,
        leaseKey: encodeLeaseKey(identity),
        source: "both",
        statedRootSessionId: identity.rootSessionId,
        leaseKeyDeprecation: null,
      };
    }

    return {
      identity,
      leaseKey: encodeLeaseKey(identity),
      source: "lease_key",
      statedRootSessionId: identity.rootSessionId,
      leaseKeyDeprecation: null,
    };
  }

  // ── Legacy only ───────────────────────────────────────────────────────
  //
  // The self-rooting default is applied HERE and nowhere else, which is the
  // point of routing every path through this function: it is scoped to the
  // deprecated shape and retires with it. A caller on the key path cannot
  // reach it at all.
  const identity: LeaseIdentity = {
    rootSessionId: input.rootSessionId?.trim() || legacySessionId,
    sessionId: legacySessionId,
    holderType: legacyHolderType as HolderType,
    holderId: legacyHolderId,
  };

  let leaseKey: string;
  try {
    leaseKey = encodeLeaseKey(identity);
  } catch (error) {
    if (error instanceof LeaseKeyError) refuseBadKey(error);
    throw error;
  }

  const omittedRoot = !input.rootSessionId?.trim();
  return {
    identity,
    leaseKey,
    source: "legacy",
    statedRootSessionId: omittedRoot ? null : identity.rootSessionId,
    leaseKeyDeprecation:
      "This claim used the legacy identity fields. They still work, and will keep working " +
      "for now, but `leaseKey` supersedes them: pass the `leaseKey` in this response on your " +
      "next claim and you can drop `sessionId`, `holderType`, `holderId` and " +
      "`rootSessionId`, which are all carried inside it." +
      (omittedRoot
        ? " Note that this claim omitted `rootSessionId`, so it was defaulted to your own " +
          "`sessionId` — meaning this claim declares you the root of your own crew. If you " +
          "were dispatched by another agent, that is wrong and is exactly what the lease key " +
          "prevents: use that agent's `leaseKey` instead."
        : ""),
  };
}

/** The legacy fields as they are compared against a key. */
interface LegacyFields {
  readonly sessionId: string;
  readonly holderType: string;
  readonly holderId: string;
  readonly rootSessionId: string | null;
}

/**
 * Refuses a call whose key and legacy fields describe different claimants.
 *
 * Every disagreeing field is named, not just the first: a caller migrating
 * to keys is likely to have several stale values at once, and reporting
 * them one round trip at a time would make the migration the slowest
 * possible version of itself.
 *
 * `rootSessionId` is compared only when supplied, so a caller that passes a
 * key plus the fields it happens to still have — but not the root — is not
 * refused for an absence the key already answers.
 */
function assertLegacyAgrees(identity: LeaseIdentity, legacy: LegacyFields): void {
  const disagreements: string[] = [];

  if (legacy.sessionId !== identity.sessionId) {
    disagreements.push(
      `\`sessionId\` is ${legacy.sessionId} but the key names ${identity.sessionId}`,
    );
  }
  if (legacy.holderType !== identity.holderType) {
    disagreements.push(
      `\`holderType\` is ${legacy.holderType} but the key names ${identity.holderType}`,
    );
  }
  if (legacy.holderId !== identity.holderId) {
    disagreements.push(`\`holderId\` is ${legacy.holderId} but the key names ${identity.holderId}`);
  }
  if (legacy.rootSessionId !== null && legacy.rootSessionId !== identity.rootSessionId) {
    disagreements.push(
      `\`rootSessionId\` is ${legacy.rootSessionId} but the key names ${identity.rootSessionId}`,
    );
  }

  if (disagreements.length > 0) {
    throw new GuardRejectedError(
      LEASE_KEY_CONFLICT_GUARD,
      `This claim passed both a \`leaseKey\` and legacy identity fields, and they disagree: ` +
        `${disagreements.join("; ")}. Neither is preferred silently, because each would be ` +
        `the wrong choice in some real case and the difference is about WHO is claiming. ` +
        `Drop the legacy fields and keep the \`leaseKey\`, or correct them to match it.`,
      {
        fields: ["leaseKey"],
        details: { disagreements },
      },
    );
  }
}
