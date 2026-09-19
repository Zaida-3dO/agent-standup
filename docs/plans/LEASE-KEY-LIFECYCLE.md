# The lease key — the whole lifecycle

How a caller **obtains** a crew identity, **carries** it, how the server **verifies** it, how the
legacy shape **migrates**, and the condition under which it is **removed**.

**Companion docs:** `SCHEMA.md` (tables, config, endpoints) · `DECISIONS.md` §20 (the bootstrap
decision this document settles) · `src/lib/lease-key.ts` and `src/lib/lease-resolution.ts` (the
module headers, which remain the authority on *why this codec* and *what a call meant*).

---

## 0. Why this document exists at all

Three fixes landed in sequence — the key itself, then refusals that pointed at a call which could not
help, then a claim response believed to be dropping the field. Each was correct. Each exposed the
next gap. The fourth gap was found only by reading the feature end to end, and it is worse than the
three before it (§4).

The structural cause is not a testing gap. It is this:

> The lease key's entire specification is module headers. `SCHEMA.md` — which `lease-key.ts` cites
> in its **first line** as the spec — contains no mention of it, and neither does any other document.

Module headers in this repo are unusually good, and they are the right place to argue *why this
codec* and *why absence refuses*. They are structurally unable to hold *where does a key come from,
who must present one, what reads expose one, and how does the legacy shape retire* — because those
questions span files, and a header is scoped to its file.

So every fix was scoped to the file in view, and the next gap was invisible from there. **This
document is the missing scope.** It is the thing to update when the feature changes, and the thing to
read before changing it.

---

## 1. What a lease key is, in one paragraph

One string carrying the four things a claim needs to know about who is claiming: `rootSessionId`
(the crew), `sessionId` (the holding session), `holderType`, and `holderId`. It is a **derivation**
of those four fields — `base64url` over a U+001F-joined payload, plus a truncated SHA-256 checksum —
not a token looked up in a table. Decoding is a pure function, so a key needs no storage to be valid
and cannot be "not found".

**It is not a security boundary and must never be described as one.** Anyone who can call the API can
mint one for any identity, exactly as they could already pass any `sessionId` they liked. The
checksum catches transcription damage and nothing else. Several decisions below — notably exposing
keys on read paths (§6) — are defensible *only* because this is true. If that ever changes, those
decisions must be revisited in the same breath.

**What the key actually buys is one thing: it converts an omission into a refusal.** Where
`rootSessionId` is an optional field defaulting to the caller's own `sessionId`, that default is
right for an orchestrator and always wrong for a dispatched agent — and never visible either way. An
omission is indistinguishable from a deliberate root claim: there is no value to typo and nothing to
validate. Hold on to that sentence; §4 turns on it.

---

## 2. Obtain

A caller needs a key before it can claim. There are exactly two intended issuers, and two more that
issue by accident.

| Source | Issues a key? | Status |
|---|---|---|
| `claim` / `ownership {action: "claim"}` | **Yes** | Intended. The only documented issuer. |
| `session {action: "register"}` | **No** | Intended as shipped; **changes under §4's decision.** |
| `release` | **Yes** | **Accidental.** See §2.1. |
| `takeover` | **Yes** | **Accidental**, and it is somebody else's key. See §2.1. |
| `orientation`, `my_work`, `get_board`, `get_item {full: "detail"}` | No | Gap — see §6. |

### 2.1 `release` and `takeover` issue keys by accident

Both return a raw `Assignment` row, and that row has carried a `leaseKey` column since the key
shipped:

- `src/lib/service/operations/release.ts` — `UPDATE "Assignment" … RETURNING *`, and the handler
  returns that row unmodified.
- `src/lib/takeover.ts` — `UPDATE "Assignment" … RETURNING *`, surfaced as `TakeoverResult.superseded`.

Neither is deliberate: no comment, test or contract rule mentions it. It directly contradicts the
contract text on `claim`, which says a key "comes from a claim response — that is the only call that
issues one."

This is the *opposite* of a leak of secrets — it is an **undocumented supply**, and a contract that
is false in the safe direction is still false. `takeover` is the sharper case: the key it returns
belongs to the **displaced holder**, so a caller that took an item over is handed the identity of the
crew it just displaced. Nothing bad follows from that, because nothing reads a key back in (§9), but
it is exactly the shape that becomes a real defect the moment something does.

**Resolution:** give both explicit column projections rather than `RETURNING *`. `release` acts on
the caller's own row and is already identified by `sessionId`; `takeover` names `fromSessionId` and
`bySessionId` separately and deliberately, because getting them the wrong way round must be
refusable. Introducing a key into either would collapse a distinction that exists on purpose. The
existing refusal of `leaseKey` as an input on non-claim actions is correct and stays.

---

## 3. Carry

One field, `leaseKey`, on `claim`. Every surface accepts it, but one accepts it only under a spelling
nobody would guess.

| Surface | Accepts `leaseKey`? |
|---|---|
| HTTP (`POST /api/claims`) | Yes, and returns it. |
| MCP (`ownership {action: "claim"}`) | Yes, and returns it. |
| CLI (`standup session claim`) | Only as `--leaseKey`; `--lease-key` is refused. |

**The CLI's gap is narrower than "it cannot pass a key", and it is worth being exact about, because
the exact shape decides the fix.** `src/lib/cli/` contains zero `leaseKey` references, and the claim
verb does not list the field — but it does not need to. `passThroughFlags` copies every unconsumed
value-flag to the input **verbatim**, and `commands-ownership.ts`'s header makes that deliberate:
listing value-flag names in the verb table "would turn this table into the allow-list that silently
drops a field."

So `--leaseKey lk1…` reaches the operation and works. `--lease-key lk1…` arrives under the key
`"lease-key"` and is refused by `claim`'s `.strict()` schema as an unrecognised field. There is no
*generic* kebab-to-camel conversion; `buildVerbInput` provides a per-verb `rename` map for exactly
this, used by `commands-admin.ts`, `commands-scoring.ts` and `commands-sessions.ts`.

**The fix is therefore a `rename` entry, not a new field**, and the distinction matters: adding
`leaseKey` to the verb table would be the allow-list mistake that header warns against. A refusal of
the hyphenated spelling is at least honest — the field is named and rejected — but it refuses the
spelling every other multi-word flag in the product uses, which reads as "the CLI does not support
this."

There is a second, quieter problem on the same path. The claim verb injects `sessionId` from
`--session`. A caller passing a key *and* `--session` does not hit the disagreement guard, because
that guard only engages when all three of `sessionId` + `holderType` + `holderId` are present. A lone
`sessionId` beside a key is **silently ignored** — neither compared nor applied. Whatever the CLI
does here, it must not be silence.

### 3.1 The dispatch hand-off is convention, and that is acceptable

There is no mechanism carrying a key from an orchestrator to the agent it dispatches. It travels as
prose in a dispatch brief, typed by a model into a field. `parentSessionId` exists and explicitly does
**not** satisfy identity.

Given the threat model (§1), convention is the right answer and a transport would be over-building.
What must change is not the hand-off but the **failure**: a dispatched agent that ends up presenting
the wrong identity should be refused by name rather than quietly forming a second crew. That is §4.

---

## 4. The decision: the bootstrap, and how the deprecation ends

### 4.1 The dead end

The documented bootstrap, in the product's own refusal text:

> If you are an orchestrator starting your own crew and so have no key to be given, make your first
> claim with the legacy fields and use the `leaseKey` it returns from then on.

So a first key is obtainable **only** by claiming with `rootSessionId` + `sessionId` + `holderType` +
`holderId` — the exact fields the key exists to replace, and which every refusal calls deprecated.

`lease-resolution.ts` states that the self-rooting default "is scoped to the deprecated shape and
retires with it." Both cannot be true. **On the day the legacy fields are removed, no caller anywhere
can obtain a first key.** The feature cannot reach its own end state.

Nobody has tripped over this because the migration has not started. It is not a bug in any file; it
is a property of the lifecycle, which is why it was invisible until someone read the lifecycle.

### 4.2 The objection that was raised, and why it was right

Making registration issue a key was considered and rejected, and the argument is worth quoting
because it is a good one:

> A registering session is not yet a holder, so the only key registration could mint is one rooted at
> *itself*. That is the right key for exactly one caller — an orchestrator rooting its own crew — and
> the wrong one for the caller who reads this message most, a dispatched agent. Issuing it would
> restore the silent self-rooting default `resolveLease` refuses, one call earlier and wearing the
> server's authority.

That is sound, and it is sound against the proposal as it was made.

### 4.3 The decision — **Option A: registration issues a key that says what it is**

**Decided: registration issues a key carrying its own provenance.** A fifth field, `origin:
"self_rooted" | "claimed"`, and a prefix bump to `lk2`.

The load-bearing word in §4.2's objection is **silent**. The feature's entire thesis is that the
original bug was an *omission which looks identical to a deliberate root claim* — "no value to typo
and nothing to validate." A key stamped `self_rooted` is **precisely a value to validate.** The wrong
state stops being invisible and becomes nameable, and a nameable wrong state can be refused with a
sentence that says what the caller did.

So Option A does not weaken the original argument. It applies that argument one level up: the same
move the key made for *absence*, applied to the remaining silent-wrong-result case. The objection
holds against a key **indistinguishable** from a claimed one. It does not hold against one that
**says what it is**.

What then becomes possible:

- An orchestrator registers, receives a usable `self_rooted` key, and never touches the legacy fields.
- A dispatched agent presenting a `self_rooted` key on an item another crew already holds is refused
  **by name** — "this key is your own, not the one you were dispatched with; ask the agent that
  dispatched you for its key" — instead of silently rooting a second crew.
- The legacy fields can actually be removed, because the bootstrap stops depending on them.

It costs one enum field in the payload and a prefix version bump.

### 4.4 The alternatives, and why they lost

**Option B — keep the legacy fields permanently as a bootstrap-only path.** Honest and free, and it
must be *stated* if chosen: the system then carries two identity shapes forever, plus the
disagreement guard between them, and every refusal that calls the legacy fields "deprecated" is
lying. A permanent path described as temporary is its own defect. Rejected because the deprecation is
genuinely wanted and Option A's cost is one enum field — but note that **B is what the system does
while believing it is doing A**, and that is the worst of the three.

**Option C — orchestrator identity comes from the transport.** The API is already authenticated, so a
registered session could be bound to its caller and the server could mint the root. Strongest result,
but it is an authorisation model layered on a state machine that already answers those questions —
the same trade `DECISIONS.md` §19 declined. Out of proportion.

### 4.5 What this decision costs, stated plainly

Two tests pin the *current* decision and will need to be inverted by the row that implements Option A.
They are not obstacles; they are the guardrails working, and they were written deliberately:

- `tests/describe-tool.test.ts` asserts a registration response has no `leaseKey`, as the second half
  of an invariant proving the issuer list is not vacuous. Under Option A registration **becomes** an
  issuer, so that assertion inverts and the `ISSUERS` list grows.
- `tests/session-registration.test.ts` carries the matching pin.

Also: `lease-resolution.ts`'s header argues §4.2 at length. It must be rewritten in the same commit,
not left to contradict this document.

**This document does not change any of that**, because it is a document. Until the implementing row
lands, the repository remains self-consistent and describes Option B behaviour with Option A recorded
as the decision. Anyone reading a refusal in the meantime is reading accurate text.

---

## 5. Verify

Verification is deliberately non-cryptographic and stays that way.

`resolveLease` decides what a call meant, from four cases: key only (the intended shape), legacy only
(still works, response carries a deprecation sentence), both (accepted only when they agree, refused
naming **every** disagreeing field), and neither (**refused**).

The refusal-on-absence is the feature's achievement and is kept unconditionally under every option
above.

**What is not verified, and should be:** nothing checks that a key is *current*. The checksum catches
damage; nothing catches **staleness**. A key copied from an old brief, naming a session long since
superseded or released, is accepted in silence. The fix is to extend the existing
`rootSessionWarning` philosophy to the key — **warn, never refuse** — because a root session that has
legitimately ended is indistinguishable from a typo, and refusing it would break a flow the design
deliberately permits.

---

## 6. Read — where a key can be recovered

No read path exposes `leaseKey` at all. `get_item {full: "detail"}` exposes `sessionId` and
`rootSessionId` per assignment but not the key.

This is a real hole, and it has a direction. A session that dispatched a subagent and then compacted,
or an agent joining a crew already in flight, can reconstruct the **legacy** fields from a read but
cannot obtain a **key** from any read at all. So every recovery path is biased back onto the
deprecated shape — the system pushes callers toward the thing it is trying to retire.

**Resolution:** `orientation` should expose the crew's lease key. It is the designated catch-up call
and the only reasonable recovery path for a compacted orchestrator. Adding it to
`get_item {full: "detail"}` closes the same hole from the other side at no cost.

**This is defensible only because a key is not a secret (§1)** — it is a derivation of four fields
those same reads already show. It is the strongest practical reason for keeping the key explicitly
non-secret forever: the moment it becomes one, both of these become leaks.

---

## 7. Migrate

Order matters; each step depends on the one before.

1. **Deploy and verify the shipped key.** Nothing below should be built on an assumption about
   production behaviour. A claim response that carries no key on a server that predates the feature
   is a deploy gap, not a defect — and confusing the two has already cost one wrongly-filed P0.
2. **Option A: `origin` + the `lk2` prefix**, registration becomes an issuer, and the
   dispatched-agent-presenting-a-self-rooted-key refusal (§4.3) lands with it.
3. **Reach: CLI support (§3) and `orientation` exposure (§6)**, so every surface can both carry and
   recover a key. The legacy fields cannot be removed while any surface still requires them.
4. **Close the accidental issuers (§2.1)** — explicit projections on `release` and `takeover`.
5. **Success-path tests (§10).** The happy path must be pinned before the legacy path is removed,
   because after removal there is no fallback to mask a regression.
6. **Flip the legacy path to warn loudly** — still accepted, but the deprecation sentence escalates.
   This is the step that produces evidence for §8's trigger.
7. **Remove the legacy fields and the self-rooting default together.** They are one decision:
   `lease-resolution.ts` already scopes the default to the deprecated shape, and leaving the default
   behind would reintroduce the original bug with nothing to state identity.

---

## 8. Remove — the end condition

**The legacy identity fields are removed when all four of these hold:**

1. **Option A has shipped** — registration issues a `self_rooted` key. Without this there is no
   bootstrap and removal is impossible (§4.1). This is the hard precondition; the rest are readiness.
2. **Every surface can carry a key** — HTTP, MCP **and** CLI (§3).
3. **Every surface can recover one** — `orientation` exposes it (§6), so a compacted or joining
   session has a path that does not route through the deprecated shape.
4. **The warn-loudly window (§7 step 6) has passed with no legacy claims observed** from callers that
   could have used a key.

**This is a trigger, not a date.** A date would be a value stated in prose with no mechanism behind
it — wrong from the moment the world moves and nothing tells you, which is the exact failure
`scripts/check-doc-version-claims.mjs` exists to prevent. The conditions above are each observable.

**Until all four hold, the legacy fields are supported, not merely tolerated.** A refusal or a
document may call them deprecated; none may imply they are about to stop working, and none may name a
removal date.

---

## 9. Two loose ends this document does not settle

**`Assignment.leaseKey` is write-only.** The column is indexed, and no query anywhere filters on it —
there is no `WHERE "leaseKey"` in the source. An index on a column no read uses is pure write cost.
Either a lookup-by-key read is planned and missing, or the index should go. The audit argument for
storing the value (an encoding change stays visible in old rows) is reasonable and is why the
*column* should probably stay even if the *index* does not.

**The encoding is over-engineered for its stated goal, and is not worth reversing.** The benefit —
"identity must be stated explicitly, and absence is refused" — is delivered entirely by requiring an
explicit field. A required `identity` object would achieve the same refusal with no codec, checksum,
column or migration. Opacity also has a real cost against a non-adversarial threat model: you cannot
look at `lk1.ChBhLi4u.9f3c2a1b` in a dispatch brief and notice the root is wrong, where you can look
at a `rootSessionId` and notice. The one argument that survives is the dispatch ergonomic: one value
is harder to partially copy than four fields of which one is optional and defaults dangerously.

**This is recorded as an honest assessment, not a proposal.** It has shipped, it works, and reversing
it would cost more than it returns. It is written down so that the next person to look does not have
to rediscover it, and so that nobody mistakes the codec for the part that prevents the bug.

---

## 10. What the tests must pin

The current test file for the key is thorough about the two pure modules and imports nothing else —
no operation, no adapter. The consequence is stark: **the only assertions in the whole suite about a
response carrying a lease key are assertions that it does NOT.** Every other reference asserts a
refusal. The feature's happy path is asserted nowhere.

Minimum set, before step 7 of §7:

- A claim through **each adapter** returns a `leaseKey`.
- A legacy claim also returns a `leaseKeyDeprecation` sentence; a key-only claim returns `null` for it.
- A claim **stores** the key it was given. There is a live mutant here: `claims.ts` writes
  `input.leaseKey ?? encodeLeaseKey(…)`, and inverting it to always re-derive would pass every
  existing test, because the derivation produces the same string either way. It is harmless while the
  encoding is fixed and becomes harmful the moment it moves — which §4.3 moves it.
- `release` and `takeover` responses do **not** carry a key (§2.1).
- The CLI accepts a key and refuses, rather than ignores, a contradictory `--session` (§3).
