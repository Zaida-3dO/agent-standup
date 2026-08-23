# CLAUDE.md — Agent Standup

A task tracker for AI coding agents. Next.js (front end and API in one bundle) · Prisma · Postgres.
Image built in CI → pushed to GHCR → **pulled** on the server. Never built on the server, no bind
mounts.

Plans live in [`docs/plans/`](docs/plans/): `PLAN.md` (how it works), `SCHEMA.md` (tables, config,
endpoints), `DECISIONS.md` (why), `MILESTONES.md` (the work, as PR-sized pieces with prerequisites).

---

## What a session can do end to end

An item minted through the product walks the full state machine on service calls alone —
`plan_review → executing → in_review → merged` — because the artifacts each transition guard reads
are writable through the service.

Two decisions in `record_artifact` are load-bearing and worth knowing before changing it.
`reviewRound` defaults to the item's current round, which is what lets the merge gate — it takes
`max(reviewRound)` across every kind — read a commit at the round its own review is on.
`createdByType` is resolved from an explicit creator or a live assignment and is **never guessed**,
because it decides whether a human authorised a merge on a `needs_approval` item.

`request_review` is a separate operation from recording a review, not an oversight: the two are
opposite ends of the same exchange, made by different parties at different times, and the event
points at no artifact row precisely because there is nothing yet to point at.

MCP tools are derived from the operation registry (`src/lib/mcp/tools.ts` over
`src/lib/service/registry.ts`), so registering an operation is the whole of that adapter's work.
Resist adding a second list of tools — there is nowhere to forget an operation.

### The hook

A single script (`src/bin/standup-hook.ts`) serves `PreToolUse`, `PostToolUse` and `Stop`. **It pings
the server and does what it is told.** It holds no rules, no matcher and no cache: it reports the
event, renders the answer, and that is the whole of it. Every rule worth having is conditional on
item state, claim state, review artifacts or budget, none of which a script can see.

Keeping it this thin is what protects the **protocol version**. A hook is installed on a machine and
then forgotten, so anything put in the script is a reason to one day need every installation to
update. Adding a rule there — even a small, safe one — spends that property.

The phases are not symmetrical. `PreToolUse` holds the call until the server answers and denies on a
`block`. `PostToolUse` and `Stop` report and may carry a nudge, but **can never block**: the call has
already run. That invariant is enforced independently in the script and in the service operation, so
breaking it takes both being wrong at once.

**It fails OPEN** — an unreachable server, an unreadable payload and an unrecognised decision all
allow. `DECISIONS.md` §16 carries the reasoning and the note that row #128 must revisit it for `pre`
once real blocking exists.

The hook is built but deliberately absent from `package.json`'s `bin`: it is a path a tool is
configured to execute, not a command a person runs.

### Interventions

`src/lib/interventions/` is the shape gating returns in (`docs/plans/INTERVENTIONS.md`, row #128): a
registry keyed by id, each entry declaring a phase, an audience, a default level, timing and two
messages. A **predicate returns a verdict as a value** — `{triggered, level?, message?, data?}` — and
the registry decides what to do with it; a predicate that emitted its own nudge could never be
swapped for an external script. Predicates read only the context handed to them and reach no
database, which is the contract that makes user-supplied entries possible later.

---

## ⚠️ This repository is PUBLIC

Anything committed here is world-readable **the moment it is pushed, and permanently** — deleting it
in a later commit does not remove it, because that commit is still in the history. Assume anything
that lands here has already been read and indexed.

### Scan every commit before making it

Check the staged diff — not just the files you think you touched — for:

| Category | Examples of what to look for |
|---|---|
| **Credentials** | Tokens, passwords, API keys, bearer tokens, session cookies, connection strings with a password, private keys, `.docker/config.json`, any real `.env` |
| **PII** | Real people's names, emails, phone numbers, addresses, OS usernames, account handles |
| **Local paths** | Anything absolute — `C:\Users\...`, `/home/...`, mapped drive letters, network share paths |
| **Private infrastructure** | Internal hostnames, LAN IPs, private URLs and dashboards, port mappings that reveal a real deployment |
| **Private project names** | Names of the owner's other repos, self-hosted services, or automation tooling |

```bash
git diff --cached          # read it, all of it, before every commit
```

Treat a finding as a **stop**, not a note to fix later — with one narrow, named exception below. Do
not read that exception as license to grade anything else in the table more gently; it applies to one
thing only.

**Exception: agent and crew codenames.** A crew member's working codename — an internal identity
assigned to a worker instance, never a real person, host, credential, or product name — is **shorthand,
not a secret**. It identifies no one and exposes nothing; there is nothing behind it to compromise, so
it does not belong in the same severity as the rest of this table. Apply it consistently:

- **In commit messages and pull-request bodies, a codename is fine.** Narrating who reviewed, found,
  or fixed something by its working name is not a finding, and does not need rewording, amending, or
  a rebase to remove.
- **In tracked files, prefer role over name** — "the review found," "an earlier pass fixed," rather
  than a codename — because a file is read long after the codename means anything to anyone. But a
  surviving instance is a **note**, worth cleaning up the next time that file is already being
  touched, not a blocker held on its own.
- **Everything else in this table is unchanged.** Credentials, PII, paths, hosts, and every other
  private project name are still an unqualified stop. This carve-out is about codenames specifically,
  not a general softening of what counts as private.

### Writing rules that keep it clean

- **Refer to people by role, never by name.** "the user", "a second user", "another person". Example
  identifiers in docs and fixtures are placeholders (`user-a`, `user-b`), never real ones.
- **No absolute paths.** Not in code, not in docs, not in compose files. Anything machine-specific is
  an environment variable; `.env.example` carries the *key* with a placeholder value, never a real one.
- **Name no private services.** Refer to them by what they are — "the NAS", "the chat channel", "the
  media MCP" — not by the product or the deployment's own name for them.
- **Generic examples only.** Example area names, repo names, and machine names in docs must be
  invented (`web`, `infra`, `desktop`, `laptop`), not copied from the real setup.
- **Never write a denylist of the real values into this repo.** Listing the actual names, hosts, or
  usernames "so they can be grepped for" publishes exactly what the rule exists to keep out. Scan by
  category, using judgement.
<!-- external-ref-ok-next-line: this rule has to quote the phrasing it forbids in order to state it -->
- **Nothing is described by what it succeeds.** No predecessor, no prior state, no "replaces X", no
  setup the reader is assumed to already run. Everything here reads as an application built from
  scratch, because that is the only version a reader of a public repository can verify — and a
  feature that exists *because* of a migration is still describable by its capability ("a one-time
  import from an external file-based store"). Where a decision's reasoning genuinely was "because
  the other thing did X", rewrite it to the underlying principle. That is almost always the better
  sentence, and it survives the other thing changing.

### The check that enforces the last rule

```bash
npm run check:external-refs     # every tracked file; runs in CI on every PR
```

<!-- external-ref-ok-next-line: naming the shapes it matches is the documentation; they are grammar, not real values -->
It matches **pattern shapes** — `today's`, `the old …`, `replaces`, `port of` — and deliberately
**never a list of the real values**, per the rule above.

**A green run means the recurring phrasings are absent. It does not mean the prose is clean** — and
the difference is worth knowing before you trust a tick. No shape matches a private proper noun
dropped into a sentence, or a sentence that only makes sense to someone who has seen a system this
repository does not contain. That gap is a **cost decision rather than an impossibility**: an
allowlist of the proper nouns this repository *is* allowed to name would decide it while naming
nothing private, at the price of a list extended on every new dependency and heading, and of noise on
legitimate additions. The script's header records the reasoning. So the check is a backstop that
keeps the recurring phrasings from eating the attention **reading the diff** needs — not a substitute
for doing it.

**Recording a deliberate exception.** Some shapes have honest in-repo uses ("that commit is still in
the history"). Waive one line at a time, with a reason, in a comment the language already supports:

```markdown
<!-- external-ref-ok: why this one is really about this repository -->
// external-ref-ok-next-line: why this one is really about this repository
```

A waiver's own line is never scanned, so `external-ref-ok` covers the line it sits on and
`external-ref-ok-next-line` covers **that line and the next one with content** — blank lines between
are skipped, because Prettier inserts one after a standalone HTML comment in markdown, and a waiver
whose target shifts by a line silently excuses whatever lands in that position instead. A waiver covers the *whole* line, so attach it precisely — on a long wrapped line it
can silence more than you meant, and the run summary reports how many matches the tree's waivers are
silencing so that creep stays visible.

**A `-next-line` waiver that covers no match fails the check.** Covering nothing means it has either
drifted off the line it was written for or outlived the text it excused, and both are worth
surfacing rather than leaving in place to absorb an unrelated line later. **Prefer the same-line
form** where the language allows it: it is anchored to the text it excuses rather than to a
position, so no formatter can separate the two.

**The reason is mandatory and must read as a phrase**, not padding — a waiver that says nothing fails
the check itself, so silencing it always costs an explanation that lands in the diff beside the text
it excuses. Prefer rewording: most matches are easier to fix than to justify.

### If something sensitive is committed

1. **Do not** just delete it in a follow-up commit — the history still has it.
2. Rewrite the history and force-push (admin bypass is on for `main`).
3. **If it was a credential, rotate it.** Assume it is already compromised — rewriting history does
   not un-publish it.
4. Say so plainly to the owner rather than quietly fixing it.

---

## Testing is a core tenet

**Every feature ships with extensive tests.** Not a smoke test — tests that would actually fail if
the behaviour regressed. A PR that adds behaviour and no tests is incomplete, and saying "it's
covered by the integration tests" is not an answer when those don't exist yet.

- **Setup work is the exception, and only setup work.** Scaffolding, config, CI wiring and deployment
  plumbing don't need unit tests; they're proved by the pipeline running. Everything after that does.
- **Prefer many small PRs, each fully tested, over one large PR tested at the end.** A single
  transition guard is a perfectly good PR: the guard, and the unit tests that prove it both allows
  what it should and **rejects what it shouldn't**. The rejections are the point — a guard that never
  refuses anything passes a happy-path test suite and protects nothing.
- **Test the error paths and the boundaries**, not just the success case: the rejection message, the
  missing required field, the concurrent claim, the state that shouldn't be reachable.
- **Integration and end-to-end tests come once the surface exists** — once there's an API and a
  schema to run against, not before. Unit tests are not a placeholder for them; both are wanted.

If a change is genuinely untestable, say why in the PR rather than skipping quietly.

### Every gating script ships a self-test

Any script used as a gate — the checks under `scripts/*.mjs` that CI runs on every PR — must ship a
test proving it **fails on a seeded violation**, not merely that it passes on clean input. A gate that
has only ever been proven to pass has never actually been run against the thing it exists to catch,
and a check that cannot fail is functionally a no-op with a green checkmark next to it.

That test must also **state plainly what a green result does, and does not, mean.** A check written
against a fixed set of known shapes can only certify the absence of those shapes — it was never taught
to look for anything else, and a shape it was never given cannot be caught by widening intent alone.
`scripts/check-external-refs.mjs` and its test (`tests/check-external-refs.test.ts`) are the precedent
to follow: the script's own header states outright that a green run means the recurring phrasings are
absent, not that the prose is clean, and the test both seeds a violation to prove the gate fires and
asserts the exemption lists stay exactly as narrow as intended.

## Setting up a working tree

```bash
npm ci
npx prisma generate      # NOT optional, and `npm ci` does not do it
```

**Why the second line is called out.** There is no `postinstall` hook, so `npm ci` leaves
`@prisma/client` as the placeholder module it ships as. Every crew works in a fresh
`git worktree`, which gets its own empty `node_modules`, so an ungenerated client is the
normal state of new work rather than a broken machine — and without it several suites fail
in ways that read as defects in the code under test, not as a missing build step (the worst
of them reports `expected Error: @prisma/client did not initialize … to be an instance of
DatabaseUnreachableError`, which sends you into the boot code for no reason).

The test run refuses to start on an ungenerated client and says this in one line, so the
step is enforced rather than merely documented — see `scripts/lib/prisma-client-state.mjs`.

## Local checks before a push

`npm install` (or `npm ci`) wires a pre-push git hook (`.githooks/pre-push`, installed by the
`prepare` script — nothing to run by hand) that runs `format:check` and `lint` before a push
leaves the machine. Those are the two fastest checks CI runs, and the two that need nothing but
the source tree — no database, no container. The hook does **not** run the test suite or the
mutation harness: both need a live database and take minutes, and a slow hook is one that gets
bypassed and then protects nothing. It works identically on Windows and Linux — git runs a
`core.hooksPath` script with `sh`, and Git for Windows ships one for that purpose, so there is
nothing to install or branch on per platform.

**Bypass in an emergency:** `git push --no-verify`. CI still runs the full check list regardless,
so a bypass costs a slower feedback loop, not correctness.

### A local run without a database is quieter than it looks

Most test files self-gate on `TEST_DATABASE_URL` — `const describeIfDb = testDatabaseUrl ? describe
: describe.skip` — so with no database set, every assertion in them is **skipped**. A skip is not a
failure, so `npm test` goes green having checked none of them, and nothing in the summary says which
claims went untested. That is a comfortable green with a hole in it, and the hole has cost real time:
a change once deleted a body of behaviour and left tests still asserting the deleted version, and
every local run skipped the file and reported nothing until somebody stood up Postgres by hand.

```bash
npm run check:db-gated     # which files gate on a database, and whether this run will skip them
npm run db:up              # a local Postgres, then export TEST_DATABASE_URL to run them
```

CI runs both halves: `Static checks & build` has no database and *reports* what it is skipping, while
`Database tests` runs `check:db-gated:require`, which **fails** if `TEST_DATABASE_URL` is missing —
otherwise a service container that quietly stopped starting would skip every gated suite and pass,
which looks identical to a healthy run.

**What that check does not tell you:** it reads source text and one environment variable, and never
runs a test. A green `--require-db` means a URL was offered, not that a database answered on it, and
it recognises the gate by the shape written above — a file inventing a different spelling is invisible
to it.

## Standing authorisation — keep the queue moving

**Merging is pre-authorised. Do not stop to ask.** Once a change has been through review and its
checks are green, merge it, and then **immediately start the work that merge just unblocked** — look
up which PRs in `MILESTONES.md` have all their prerequisites met and dispatch them.

The point is that a merge is not the end of a piece of work; it is the event that releases the next
one. Waiting to be told to continue wastes the whole reason the dependency graph exists.

Two things this authorisation does **not** cover, because they aren't merges:

- Anything **outward-facing or hard to reverse** beyond the merge itself — deleting or renaming the
  repository, rewriting published history, changing who can access it.
- **Skipping the review.** Review is the gate this authorisation is conditional on. A green merge
  button is not a review, and neither is having written the code yourself in the same session.

If review finds something genuinely blocking, fix it and re-review — don't merge and file a follow-up.

### Never leave a PR unwatched

**When you open a PR, immediately start something that waits on its CI** — a backgrounded
`gh pr checks <n> --watch` with a timeout, so it returns either when the checks finish or when the
timeout expires, whichever comes first. Then act on the result.

Without it, branches get opened and quietly forgotten: the work is done, the checks went green, and
nothing merges because everyone moved on. A PR that nobody is waiting on is indistinguishable from a
PR that failed.

### Green is not the same as right

When several PRs solve the same problem, **don't merge whichever one is green first.** A change that
does less will often pass more easily — precisely because it left something stale behind. Compare
what they actually do, and prefer the one that finishes the job even if it needs a fix first.

Real example: three PRs bumped a framework major. Two were green but bumped only the framework, not
its companion lint config — passing checks while quietly mismatched underneath. The third did the
full migration and failed, on a formatting nit. Merging on green would have picked a worse change.

### You do not have to be up to date with `main` to merge — do not chase it

A PR merges when its **required checks pass** and **git can merge it cleanly**. Being `BEHIND` `main`
does not block a merge, and `main` moving while you work does not invalidate your green run.

**What this means for you:**

- **Do not rebase onto `main` just to be current.** It is not required and it is not wanted. It burns
  a full CI cycle, including the ~9-minute mutation gate, for no gain.
- **Only bring `main` in if you actually need to** — a genuine textual conflict blocking the merge, or
  a fix on `main` your work truly depends on.
- **If you do have to resolve a conflict: resolve it once, push, and hand back.** Do not re-pull
  `main` repeatedly to stay level with it. Chasing a moving branch can cost a dozen merges to land a
  single PR, and none of them buy anything.
- **Rebase, not merge**, if you do need to integrate — `main` requires linear history, so a merge
  commit still cannot land. When you do:
  - **Expect conflicts in shared files.** `package.json`, `package-lock.json` and config files are the
    usual casualties. Take `main`'s version of anything you didn't deliberately change, then re-apply
    only your own additions on top. **Never revert someone else's landed change to resolve a
    conflict** — if `main` upgraded a dependency, keep the upgrade.
  - **For a lockfile, regenerate rather than hand-merge.** `npm install` after the rebase.
  - **Re-run the full verification after rebasing, not just before.** You are now on code you have
    never tested against.

**The tradeoff you should understand, because it will routinely land on you.** Two PRs can each be
green, each be correct, and merge cleanly, and still **not work together** — one deletes a symbol the
other's test imports, or adds a guard that invalidates the other's fixtures. Git stays silent, because
the changes sit in different files. Nothing catches that combination before it lands; `main`'s own CI
catches it after.

**This is deliberate, and during a busy milestone it is the expected background rate rather than a
warning sign.** Neither PR is wrong. A semantic conflict between two independently-correct changes is
a normal integration event, and it gets *more* common exactly when things are going well — many PRs
in flight, landing fast, against a moving `main`. The posture here is:

> `main` goes red → we notice → we put up a small follow-up PR that fixes it. That is cheap and easy.
> Taxing **every** open PR to prevent it costs far more than it saves.

**So bias towards speed while the queue is deep.** The alternative — every PR rebasing to stay level,
re-running the full pipeline each time — spends real build minutes on every open branch to avoid a
handful of cheap follow-ups, and it slows the queue precisely when the queue is the thing that
matters. Land the work; fix the seams after.

So: **if `main` is red and it wasn't you, don't panic and don't hunt for a culprit.** Read the first
lines of the failing CI step — this class is almost always diagnosable straight from there — and open
a fix PR. If your own PR goes red right after someone else merges, it is very likely this, and **it is
not your fault**.

**Required checks gate every merge.** `Build & test`, `Actionlint (required)` and
`Docker build (required)` must pass. "Green is not the same as right" applies in full.

### The final pass, once the queue drains

Biasing towards speed is only safe if the seams get inspected at the end. **When a milestone's PRs
have landed and nothing is in flight, do one deliberate pass over `main` as a whole** — not over any
individual diff, which is the thing per-PR CI already did.

**Why this pass exists, and what it is for.** Per-PR CI answers *is this change correct in
isolation*. It cannot answer *does the merge result work*, because no CI run ever has the merge result
in front of it until after the merge. Most of what escapes is invisible to a gate by construction:

- **A failure spanning changes that are individually fine** — an auth or config change that is correct
  in its own PR and breaks every caller once combined. Nothing is red; nothing textually conflicted.
- **A file whose diff hid itself.** A source file that acquires a NUL byte reads as binary, so review
  sees no diff at all while every check still passes. A diff stat that says `Bin` where a `.ts` should
  be is the tell.
- **A shared type or token that drifted.** One PR widens a union while other modules still carry the
  narrower value; each compiles in isolation, and they disagree once merged.

**What the pass actually is** — cheap, and mostly not novel work:

- **Run the full suite on the merge result**, not on a branch. This is the single highest-yield step.
- **Read the diff stat for the whole milestone** (`git diff --stat`). You are looking for surprises:
  a file that shouldn't be binary, a deletion nobody mentioned, a size that doesn't match the story.
- **Render the app and use it.** Load a page, sign in, click through the surfaces the milestone
  touched. Compiling is not the same claim as working, and the front end has exactly one honest test.
- **Where the work was user-facing, that render belongs in a `visual_review` artifact** rather than in
  someone's memory — see `needs_visual_review` and the merge gate in `docs/plans/SCHEMA.md` §1. An
  item inherits the flag from its repo when the caller does not set one, so **the repo row is where
  this is decided once** rather than per item. Two things follow, and both have bitten:
  - **A UI repo whose row says `false` gates nothing**, however front-end the work is — nothing infers
    the flag from a diff. Check the row, not your intent.
  - **The gate needs `visual_review.doc` set to be satisfiable at all.** Null means visual review is
    unavailable, so an item that needs one has no way through — turning the flag on without the doc
    wedges items instead of protecting them.

Anything this pass finds is a follow-up PR like any other. Finding something here is the process
working — it is the price of the speed above, paid once at the end instead of on every branch.

### Don't pull the ground out from under a running crew

**A worktree belongs to the agent working in it until that agent has reported.** Do not
`git worktree remove` it, push to its branch, or merge its PR while it is still live — it will keep
working against a directory that has been deleted out from under it, and it cannot tell your
interference apart from a rogue process.

Clean up worktrees only after the agent that owns one has finished. If you must take over a branch
mid-flight, expect the agent's report to be confused about what happened, and say plainly that it was
you.

## Working in this repo

- **`main` is protected.** Linear history, no force-pushes, no deletions, and every change arrives by
  pull request with conversation resolution required. Zero approvals are *required* — GitHub blocks
  self-approval and everything here is authored under one account — so **review is a process gate we
  keep ourselves, not one GitHub enforces.** Don't skip it because the merge button is green.
- **One PR is one piece of work**, from `MILESTONES.md`. Build it in a worktree on its own branch.
- **A PR is available to pick up when everything in its "Needs" column is merged.** That rule is what
  makes the milestone list a work queue instead of a wish list.
- **Migrations are additive.** The whole schema lands as one baseline; change it with an `ALTER`,
  never by editing a migration that has already been applied.
- **After ANY change to `schema.prisma`, run `npx prisma generate` — especially for a new enum
  value.** Applying the migration is only half of it: the migration teaches *Postgres* the new
  label, while the generated client carries its own copy of the enum and validates against that.
  Skip the generate and Prisma rejects the new value **at the client layer**, before a query is
  ever sent — so the database genuinely has the label, `\dT+` proves it, and the write still fails.
  The error names the value as invalid, which reads like a migration that did not apply and sends
  you to inspect the database, where everything looks correct. Do the generate first and the whole
  confusion never starts. This is also why `npx prisma generate` is a separate step in every CI job
  here (`ci.yml`) and in the local-development block in `README.md`, and why a **fresh worktree
  needs it even with no schema change of its own** — `node_modules` starts empty, so there is no
  generated client at all until you run it.
- **Branch from `main`, never from another PR's branch.** CI's `pull_request` trigger filters on
  `branches: [main]`, so a PR opened against a branch that is itself not `main` matches no event and
  runs **zero** checks — and a PR with no runs at all reads as quiet, not red, which is easy to miss
  when several agents are working in parallel here. No checks is not the same claim as checks passed.
  **That is not the only way to get zero checks, and it is not the most likely one. When no checks
  appear, check `mergeable` first** — `gh pr view <n> --json mergeable,mergeStateStatus` — because a
  PR that cannot merge runs nothing either, and the two are byte-identical from the outside. Several
  PRs merge per hour here, so a branch acquiring a conflict between opening and CI starting is
  routine, while a wrong base branch is a one-off mistake. Ruling out the base branch and then
  reaching for trigger filters or Actions rate limits is the expensive path, and it has been walked:
  the cheap question is whether the PR is mergeable at all. A doc line relies on someone remembering,
  which is exactly what failed, so this is also filed as intervention **I7** in
  `docs/plans/INTERVENTIONS.md` — the server can see both halves and say so.
  There is also a sharp corollary worth knowing before it happens: merging a parent PR with
  `--delete-branch` **auto-closes any PR still open against that branch**, and this cannot be undone
  by reopening or retargeting the closed PR — the only way out is a new PR opened from the same,
  unchanged branch against `main`. Never rebase onto `main` to try to recover it: an approval is
  granted against a specific set of commit shas, and a rebase mints a fresh set — so a rebase always
  needs a fresh approval to match, whatever the reason for rebasing.
- **Every adapter is a thin shell over a service call.** No adapter may reach the database or a guard
  directly — it resolves input, calls one service operation, and shapes the result for its transport.
  Only the service layer (`src/lib/service/`), the settings resolver (`src/lib/settings/`), and
  migrations/seeds (`prisma/`) may import the database client; everything else, including every
  adapter, calls the service layer instead. This is enforced two ways — an ESLint
  `no-restricted-imports` rule (`eslint.config.mjs`) and an independent import-graph check
  (`npm run check:db-imports`, `scripts/check-db-import-allowlist.mjs`) — so the rule holds even if
  one mechanism is bypassed or disabled. Read this before writing an adapter, not after a failing
  lint: a service call is the only path in.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`). Say what changed
and why; the diff already says how.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
