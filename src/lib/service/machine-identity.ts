// Which machine a call is recorded against — the proved one, when the
// transport proved one. MILESTONES.md #134/#133 (per-machine tokens),
// DECISIONS.md's "one is proved and one is declared".
//
// ── The gap this closes ─────────────────────────────────────────────────
//
// Per-machine bearer tokens already authenticate every HTTP and MCP call,
// and the machine a token resolves to is carried as `ctx.caller.machine`,
// deliberately separate from `ctx.caller.actor` because one is *proved* by
// the transport and the other is merely *declared* by the caller. That
// separation was built and then went unused: the proved value was plumbed
// to the route boundary and dropped there, while `register_session` wrote
// the body-supplied `input.machine` into the `Session` table. A caller
// authenticating as `laptop` could register a session claiming
// `machine: "desktop"`, and the server stored the claim.
//
// ── The rule, stated rather than left to last-writer-wins ───────────────
//
// Three cases, and the third is the one that makes this safe to deploy:
//
//   1. **Proved and declared agree** — the proved value is stored. No
//      observable change, which is the ordinary path for every correctly
//      configured client.
//   2. **Nothing proved.** The declared value is stored, exactly as before.
//      This is not a loophole being left open; it is the CLI's `direct`
//      binding, which is the same trust boundary as the process itself and
//      has no token to present. "Not established" is a different fact from
//      "contradicted" and must not be punished as one — treating them alike
//      would break the command line for no security gain, since a caller
//      already running in-process can do anything the service can.
//   3. **Proved and declared contradict.** The proved value wins and the
//      declaration is discarded. It is *not* a refusal — see below.
//
// ── Why an override rather than a 403 ───────────────────────────────────
//
// A refusal was the tempting answer: a contradiction looks like either a
// misconfiguration or an impersonation attempt, and both seem worth
// shouting about. It is rejected because of what it would do to the honest
// majority. The declared machine is a client-side string a launcher fills
// in from its own idea of the hostname; the proved one is whatever name an
// operator wrote in the token table. These disagree constantly and
// innocently — `laptop` versus `laptop.local`, a hostname that changed, a
// token table naming machines by role rather than by host. Refusing
// registration would take those sessions offline at the handshake, which is
// the one call a session makes before it can do anything at all, and the
// operator's only route back is editing a token table they may not own.
//
// Meanwhile the security property is identical either way. The attack being
// closed is a caller *storing* a machine name it does not hold; overriding
// stores the proved name, so the false claim never lands. A refusal would
// additionally deny service to the liar, which is worth nothing here
// because the liar already authenticated — it holds a valid token for
// *some* machine, and the honest record of which one is exactly what the
// override writes.
//
// The discarded claim is not silently swallowed: the resolution is returned
// as a discriminated result so callers can surface it, and
// `register_session` reports it on the response.

/** What `ctx.caller` carries that this resolution reads. */
export interface MachineCaller {
  /**
   * The machine the transport proved, when it proved one. Absent on the
   * `direct` binding, which has no token to present.
   */
  readonly machine?: string;
}

/** The machine to record, and how it was arrived at. */
export interface ResolvedMachine {
  /** The value to store. */
  readonly machine: string;
  /**
   * How `machine` was established.
   *
   * `proved` — a token resolved to it. `declared` — nothing was proved, so
   * the caller's own word was taken.
   */
  readonly source: "proved" | "declared";
  /**
   * The machine the caller claimed, when it contradicted the proved one and
   * was therefore discarded. `null` on every ordinary call — including when
   * the two agree, since nothing was overridden.
   *
   * Present so an operator can see *that* a contradiction happened rather
   * than having to infer it from a stored value quietly differing from what
   * a launcher sent.
   */
  readonly overrode: string | null;
}

/**
 * Resolves the machine to record from what the transport proved and what
 * the caller declared.
 *
 * Pure, and separate from any operation, so the rule above is testable
 * without a database or an HTTP request — and so a second call site
 * adopting it (assignments, artifact attribution) inherits the same three
 * cases rather than re-deriving them slightly differently.
 */
export function resolveMachine(caller: MachineCaller, declared: string): ResolvedMachine {
  const proved = caller.machine;

  // Nothing proved: the `direct` binding, and any transport that cannot
  // establish a machine. The declaration stands, unchanged from before.
  if (proved === undefined) {
    return { machine: declared, source: "declared", overrode: null };
  }

  // Proved and declared agree — the ordinary authenticated path. Recorded
  // as `proved` because it is: the token established it, and the agreement
  // is what makes the override invisible to a correctly configured client.
  if (proved === declared) {
    return { machine: proved, source: "proved", overrode: null };
  }

  // Contradiction. The proved value wins; the discarded claim rides along
  // so the caller is told rather than left to notice.
  return { machine: proved, source: "proved", overrode: declared };
}
