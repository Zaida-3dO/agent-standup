// The **lease key** — one field carrying the four things a claim needs to
// know about who is claiming (SCHEMA.md §2).
//
// ── The failure this prevents ───────────────────────────────────────────
//
// `claimItem` resolved an absent crew root with `input.rootSessionId ??
// input.sessionId` (claims.ts). For an orchestrator that default is right:
// a root points at itself. For a **dispatched agent** it is always wrong —
// it declares the agent the root of a second crew, and `assertSameCrew`
// then either refuses the claim it was sent to make or, when the agent
// claims first, quietly attributes the work to a crew that does not exist.
//
// The shape of that bug is what makes it expensive: the field is optional,
// so the mistake is an OMISSION, and an omission looks identical to a
// deliberate root claim. There is no value to typo and nothing to validate.
// The product's own contract text had to spend a paragraph warning callers
// off a default its schema actively invited, which is the tell that the
// default was in the wrong place — documentation compensating for a shape.
//
// A mistyped `rootSessionId` was likewise accepted and merely warned about,
// so a brief could believe it had crew protection for a whole run while
// having none.
//
// ── What a lease key is ─────────────────────────────────────────────────
//
// A single opaque-looking string that the SERVER issues and the caller
// pastes back. It carries, in one value:
//
//   - `rootSessionId` — the crew this claim belongs to
//   - `sessionId`     — the session holding it
//   - `holderType`    — person or agent
//   - `holderId`      — who that is
//
// Those four stop being four things a caller has to get individually right
// and become one thing it either has or does not. **Absence is now a
// refusal** rather than a default, which is the whole point: a dispatched
// agent that was told nothing gets told, at the moment it calls, exactly
// what to ask its orchestrator for.
//
// ── Why encoded rather than a random token ──────────────────────────────
//
// A random token would need a table, a lifetime, and a lookup on the claim
// path, and it would be unreadable in a log or a dispatch brief. This key
// is a *derivation* of the four fields, so:
//
//   - **It needs no storage to be valid.** Decoding is a pure function.
//     There is no issuance table to migrate, expire or garbage-collect, and
//     no way for a key to be "not found" — it is either well-formed or not.
//   - **It survives a dead root.** The existing design deliberately lets a
//     subagent carry the id of a root session that has already ended; a key
//     validated against a live table could not do that without resurrecting
//     the refusal that `1e469146` explicitly decided against.
//   - **It is legible when it matters.** `decodeLeaseKey` returns the four
//     fields, so an operator reading a refusal or a row can see whose lease
//     it was without a join.
//
// ── What it is NOT ──────────────────────────────────────────────────────
//
// **This is not a security boundary and must never be described as one.**
// It is base64url over a signed-by-nothing payload; anybody who can call
// the API can mint one for any identity, exactly as they could already pass
// any `sessionId` they liked. The checksum below catches TRANSCRIPTION
// damage — a truncated paste, a swapped character, a key from one field
// pasted into another — and nothing else. Calling it authentication would
// be a lie that some later reader would rely on.
import { createHash } from "node:crypto";

// Type-only, and deliberately so: `claims.ts` imports `encodeLeaseKey` from
// here, so a VALUE import in this direction would close a runtime cycle.
// `import type` erases at compile time, leaving the dependency one-way at
// runtime while both modules still agree on one definition of the holder
// vocabulary.
import type { HolderType } from "./claims";

/**
 * The prefix every key carries.
 *
 * Present so a wrong-field paste fails as a *lease key problem* with a
 * sentence about lease keys, rather than as a mystery. A caller who pastes
 * a bare `sessionId` into `leaseKey` is the single most likely mistake
 * during the dual-accept window, and this is what makes that diagnosable.
 */
export const LEASE_KEY_PREFIX = "lk1";

/** The four fields a key carries. */
export interface LeaseIdentity {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly holderType: HolderType;
  readonly holderId: string;
}

/** Why a key could not be read. Each maps to its own sentence at the call site. */
export type LeaseKeyDefect =
  "empty" | "not_a_lease_key" | "malformed" | "checksum" | "bad_holder_type";

export class LeaseKeyError extends Error {
  readonly defect: LeaseKeyDefect;

  constructor(defect: LeaseKeyDefect, message: string) {
    super(message);
    this.name = "LeaseKeyError";
    this.defect = defect;
  }
}

/** The holder types a key may name. Mirrors `HolderType` in schema.prisma. */
const HOLDER_TYPES: readonly HolderType[] = ["person", "agent"];

/**
 * Characters that cannot appear in a field, because they are the
 * separators.
 *
 * Fields are joined with `\u0000` before encoding, which no session id,
 * holder id or holder type can legitimately contain. Rejecting them on the
 * way IN is what keeps decoding unambiguous — without it, a holder id
 * containing the separator would decode into two fields and silently shift
 * every field after it.
 */
const FIELD_SEPARATOR = "\u0000";

function assertEncodable(field: string, name: keyof LeaseIdentity): void {
  if (field.length === 0) {
    throw new LeaseKeyError("malformed", `A lease key needs a non-empty \`${name}\`.`);
  }
  if (field.includes(FIELD_SEPARATOR)) {
    throw new LeaseKeyError(
      "malformed",
      `\`${name}\` contains a NUL character, which a lease key uses as its field separator ` +
        `and therefore cannot carry.`,
    );
  }
}

/**
 * A short checksum over the payload.
 *
 * Truncated to 8 hex characters deliberately: this detects damage, and 32
 * bits is far more than enough for that when the alternative outcome is a
 * refusal rather than a breach. A longer digest would only make the key
 * harder to paste, and the key is pasted by hand into dispatch briefs.
 */
function checksum(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 8);
}

/**
 * Builds the key for an identity.
 *
 * Pure and total: the same identity always produces the same key, on any
 * machine and in any process. That is what lets the migration's backfill
 * derive a key for every existing assignment from the columns it already
 * has, and lets that backfill be re-run without producing a different
 * answer the second time.
 */
export function encodeLeaseKey(identity: LeaseIdentity): string {
  assertEncodable(identity.rootSessionId, "rootSessionId");
  assertEncodable(identity.sessionId, "sessionId");
  assertEncodable(identity.holderId, "holderId");
  if (!HOLDER_TYPES.includes(identity.holderType)) {
    throw new LeaseKeyError(
      "bad_holder_type",
      `\`holderType\` must be one of ${HOLDER_TYPES.join(", ")}, not ${identity.holderType}.`,
    );
  }

  const payload = [
    identity.rootSessionId,
    identity.sessionId,
    identity.holderType,
    identity.holderId,
  ].join(FIELD_SEPARATOR);

  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${LEASE_KEY_PREFIX}.${body}.${checksum(payload)}`;
}

/**
 * Reads a key back, or throws a `LeaseKeyError` saying which way it was
 * wrong.
 *
 * Each defect gets its own message because each has a different remedy: a
 * key from the wrong field needs a different field, a truncated key needs
 * re-copying, and a well-formed key naming a bad holder type needs
 * re-issuing. A single "invalid lease key" would collapse three different
 * actions into one shrug.
 */
export function decodeLeaseKey(key: string): LeaseIdentity {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new LeaseKeyError("empty", "A lease key was expected and the value was empty.");
  }

  const parts = trimmed.split(".");
  if (parts[0] !== LEASE_KEY_PREFIX) {
    throw new LeaseKeyError(
      "not_a_lease_key",
      `That is not a lease key — a lease key starts with \`${LEASE_KEY_PREFIX}.\`. ` +
        `If you pasted a session id, pass it as \`sessionId\` instead, or ask whoever ` +
        `dispatched you for the lease key their own claim response returned.`,
    );
  }
  if (parts.length !== 3) {
    throw new LeaseKeyError(
      "malformed",
      `That lease key has ${parts.length} dot-separated parts and a lease key has 3. ` +
        `It was most likely truncated or joined to something else when it was copied.`,
    );
  }

  const [, body, given] = parts as [string, string, string];
  let payload: string;
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    throw new LeaseKeyError("malformed", "That lease key's body is not valid base64url.");
  }

  if (checksum(payload) !== given) {
    throw new LeaseKeyError(
      "checksum",
      "That lease key's checksum does not match its body, so it was altered or truncated " +
        "in transit. Copy it again, whole, from the response that issued it.",
    );
  }

  const fields = payload.split(FIELD_SEPARATOR);
  if (fields.length !== 4) {
    throw new LeaseKeyError(
      "malformed",
      `That lease key decodes to ${fields.length} fields and a lease key carries 4.`,
    );
  }

  const [rootSessionId, sessionId, holderType, holderId] = fields as [
    string,
    string,
    string,
    string,
  ];

  if (!HOLDER_TYPES.includes(holderType as HolderType)) {
    throw new LeaseKeyError(
      "bad_holder_type",
      `That lease key names holder type \`${holderType}\`, which is not one of ` +
        `${HOLDER_TYPES.join(", ")}.`,
    );
  }

  return {
    rootSessionId,
    sessionId,
    holderType: holderType as HolderType,
    holderId,
  };
}

/**
 * Whether a string looks like a lease key at all, without deciding whether
 * it is a *valid* one.
 *
 * Used where the question is "did the caller mean to pass a key here" —
 * notably to tell a damaged key (which deserves the checksum sentence) from
 * a value that was never a key (which deserves the wrong-field sentence).
 */
export function looksLikeLeaseKey(value: string): boolean {
  return value.trim().startsWith(`${LEASE_KEY_PREFIX}.`);
}
