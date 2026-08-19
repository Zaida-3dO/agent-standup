# Before GA

Gates to close before this ships to anyone outside the people building it.

**This is not the milestone queue.** `MILESTONES.md` answers *what to build next*; a row there is a
unit of work with dependencies, and the queue is read to pick up the next available one. The entries
here are a different question — things deliberately switched off, deferred, or accepted as
provisional while the product is still being built, each of which has to be revisited before
strangers depend on it. Filing them as milestone rows made the queue answer two questions at once
and made "what should I build next" harder to read.

**An entry here is not work in flight.** It is a decision with an expiry date attached. Nobody picks
one up because it is available; they are closed deliberately, together, as part of deciding the
product is ready.

Status: blank = still open · `closed` = decided and done.

---

## G1 — Mutation testing is off

**State:** off on every branch, `main` included. `workflow_dispatch` runs it on demand.

**How it got here.** The owner's call, 2026-08-18: the job runs only when dispatched by hand, and the
reasoning belongs beside the switch rather than in anyone's memory. It stays configured and runnable
so that turning it on is a decision someone makes, not a job someone has to rebuild.

**Why off.** Two reasons, and the second decided it:

1. **It costs 22-57 minutes per run** — far and away the slowest job in the pipeline, against
   single-digit minutes for everything else. On a pull request that lands directly on merge latency,
   which is what decides how fast work moves through the queue. On `main` nobody waits on it, but
   that is also why it gates nothing there: the merge has already happened, so a survivor is a
   notification rather than a refusal.
2. **Its first run against a service operation produced findings no test could act on.**
   `sweep.ts` scored 33-38 with four survivors, all in the `defineOperation({…})` metadata. That
   object is a module-level literal evaluated once at import, while Stryker activates a mutant at
   *runtime*, so no test written any way can kill those mutants — a property of every operation
   module rather than of one file. Left alone, each new operation entering scope would re-report the
   same tool limitation at the cost of the slowest job in the pipeline.

   **This one is largely handled.** Issue #166 addressed it across all 60 operation modules with a
   scoped disable annotation on the metadata literal, plus `scripts/check-operation-metadata-mutants.mjs`
   to keep the annotations in place, so the four false survivors are reported as `Ignored` rather
   than as findings. Worth recording that #166's *first* diagnosis was wrong and was corrected by
   running the tool rather than reasoning about it: the survivors were attributed to coverage
   attribution, and the fix that followed from that — asserting the metadata inside a test body —
   left all four alive. The reports showed `coveredBy: 3`, not 0. The mutants are unkillable by
   construction, which is a different problem with a different answer.

   Reason 1 — the cost — is the one that keeps this gate open.

**What has to be true to turn it back on:**

- ~~Issue #166 resolved, or a documented convention for what mutation testing is expected to reach in
  an operation module~~ — **done.** The metadata mutants are annotated across all 60 operation
  modules and a check keeps them there, so a run reports findings rather than a known residue.
- A decision on scope and trigger: pull request, `main`-only, or nightly. The changed-files scope
  already exists and keeps cost proportional to the diff; the open question is which event pays it.
- Agreement on what a survivor obliges. On a pull request it can block; on `main` it can only be
  filed, and filing findings nobody is committed to reading is how a check becomes decoration.

**What must not happen:** lowering `thresholds.break`, narrowing `stryker.config.json` to dodge a
file, or annotating live mutants away to force a green. Any of those turns the check into something
that reports success without providing it — which is the exact failure the job exists to catch, in
the job itself. A `Stryker disable` scoped to provably unkillable mutants, with the reason stated at
the disable and the behaviour asserted by a real test, is a different thing and is allowed.

## G2 — Both capability documents are unset, and one gate is unsatisfiable because of it

**State:** `visual_review.doc` and `notify.doc` are both `null`. Both mechanisms they gate are fully
built; neither is reachable.

**How it got here.** Not a decision — a gap, found on 2026-08-19 while asking why a milestone's worth
of front-end work never hit a visual review. Neither setting has ever been given a value, and nothing
reports that they are missing, so the absence has been invisible since the settings were introduced.

**Why it matters more than an unset default usually would.** These are not dormant switches. Each has
a live consequence while it stays unset:

1. **`visual_review.doc` null makes the visual gate unsatisfiable.** The setting's own help is
   explicit — *"Null means visual review is unavailable, and an item that needs one has no way through
   its gate."* Two repositories are registered `needsVisualReview: true` (`jcs`, `haven-dashboard`),
   so every item minted against them inherits a requirement the installation cannot fulfil. Nothing
   fails loudly; items simply cannot reach `merged` by the route the schema describes.
2. **`notify.doc` null means escalation reaches nobody.** Again from its help — *"Null means
   notifications are off — including the escalation that puts a blocked item on somebody's list."*
   An item that blocks and escalates does so into silence, which is indistinguishable from an item
   that never blocked.

**The shape of the mistake is worth keeping, because it is not "someone forgot".** `SCHEMA.md` §17.5
anticipated this exactly — it specifies the warning *"14 items require a visual review and
`visual_review.doc` is not set"* — so the condition was understood, written down, and still went
unnoticed for the entire period it was true. A documented warning nobody implemented is
indistinguishable from a warning that never fires. This is also why the related intervention
(**I18**, `INTERVENTIONS.md`) ships as a nudge rather than a block: blocking on a gate no one can
satisfy stops work without protecting anything.

**What has to be true to close it.**

- `visual_review.doc` points at a real document describing how a visual review is performed here.
  The installation may already have one, in which case this is a `put_setting` rather than
  authorship — the setting takes a path or URL, so the document does not have to live in this
  repository.
- `notify.doc` points at a real document describing how to reach people, or the installation states
  deliberately that notifications are off and accepts that escalation is inert.
- The §17.5 warning is actually implemented, so the next unset capability announces itself instead of
  waiting to be discovered. **This is the part that stops G2 recurring under a different setting
  name**, and without it the other two bullets are a one-time fix rather than a closed gate.
- Each repository's `needsVisualReview` is checked against whether it is genuinely a UI repository —
  `agent-standup` itself carried `false` while both sibling UI repositories carried `true`, which is
  what let a 26-PR front-end milestone merge without a single render.

---

---

## How to add an entry

One heading per gate, numbered `G<n>`, never renumbered — an entry that turns out to be unnecessary
is marked `closed` with the reason, not deleted, so a reference to it keeps resolving.

State four things: **what is switched off or accepted**, **how it got that way** (with the date and
whose call it was), **why**, and **what has to be true to close it**. That last part is what makes
this a list of gates rather than a list of regrets — an entry nobody can tell how to close is a
worry, and worries belong in a different document.
