# Agent Standup — the plan

**Status:** planning, no code being written yet. This doc is the one to read and correct.
There's a companion doc, `plan-technical.md`, with the detailed engineering version.

**Name settled 2026-08-09.** The product is **Agent Standup**; the command you type is **`standup`**.
The long name goes on the repo, the site and the README — "Agent" is what stops it being mistaken for
one of the many Slack bots that ask human teams what they did yesterday. The short word is what you
use daily: `standup ls`, `standup claim T-…`, `standup complete`. Published as `agent-standup`, which
also sidesteps a dead package sitting on the bare name. Both names are free on the package registries
and on GitHub.

---

## What we're building, in one paragraph

A proper app for tracking the work the AI does — replacing today's folders-of-markdown-files
plus a 1,000-line PowerShell script. It has a **database** (real state, not files), a **backend**
that all changes go through, an **MCP** so agents can talk to it, and a **web front end** so you can
look at it. One repo, one product.

The important shift: today the rules live in hooks that *ask* agents to behave. In the new app the
rules live in the backend and are *enforced*. An agent can't skip a step, because the server refuses
the change.

---

## The shape of the work: one thing, nested

You asked for project → task → subtask. The design is simpler than three separate things:

> **There is one kind of item. It can have a parent. That's the whole hierarchy.**

- A **project** is an item with no parent — "revamp the tablet dashboard."
- A **task** is an item whose parent is a project — "get the Galaxy projector card working."
- A **subtask** is an item whose parent is a task — "work out which entities the card takes in."
- A subtask can have its own subtasks, as deep as it needs to go. No special handling — a
  sub-subtask is just an item whose parent happened to be a subtask.

**Why this matters right now:** you spotted that agents already do this. When a job turns out to have
a smaller job inside it, the agent creates a whole separate task and then quietly manages both
itself. That's a subtask wearing the wrong hat, and it makes the board lie about how much is in
flight. Giving items a parent fixes that at the root.

Everything gets the same fields and the same statuses at every level. A subtask is a task.

---

## State: one flat list. Columns are just a view of it.

**Your call, 2026-08-09, and it's the right one.** The earlier draft had two levels of real state —
a status plus a sub-status. You worked out that's more machinery than the problem needs. Instead:

> **There is one list of real states. The board column is worked out *from* the state, not stored,
> and never transitioned.**

So there are no "column transitions" at all. Only state transitions. The card lands in a different
column as a *side effect* of changing state. That deletes a whole category of bug where the two
levels disagree.

**Naming the two levels**, since you asked for better terms: I'd call the real one the **state** and
the derived one the **column** — "column" being unambiguously a display thing, so nobody is ever
tempted to transition it. (Kanban calls the vertical divisions columns; the horizontal ones are
swimlanes.)

| Column (worked out, not stored) | States that land in it |
|---|---|
| **Backlog** | `someday` · `on-deck` |
| **In progress** | `planning` · `plan-review` · `executing` · `in-review` |
| **Blocked** | `blocked` |
| **Completed** | `merged` · `research-done` · `wont-do` · `cancelled` |

Eleven states, four columns. Two consequences you called out, both now automatic:

**Review rounds are real state movement, they just don't move the card.** Going from `in-review` back
to `executing` for rework is a genuine transition with its own rules and bumps the round counter —
but both states sit in the In-progress column, so nothing slides backwards on the board. You get the
guard *and* the stable visual.

**Guards live between states, and they're required-fields rather than walls.** Your example — you can
only get from planning to executing if the plan was actually approved — becomes: *you can make that
move, but you have to point at the approval.* Same protection, no dead ends.

**The local validation gate is not a state and never was.** It's a gate the builder runs on their own side.

### Blocked is narrow — but wider than I first wrote it

I had this as "only a human can unstick it." **You're right that it's wrong.** The real test is:

> **Can the AI unstick this on its own? If no, and something outside has to happen first, it's
> blocked.**

That covers people *and* time *and* external processes:

| Waiting on | Example |
|---|---|
| **You** | a decision, or a review of something too risky to do autonomously |
| **Someone else** | Another person, or an outside party |
| **An external process** | your SMART disk check finishing — nobody needs to act, it just has to run |
| **A date** | something becomes available on the 14th and work can continue then |

The date case gets a **when-to-check-back** field, which buys something the user's setup can't do
at all: **the server can unblock it for you when the time comes**, rather than it sitting there until
someone notices.

**What is deliberately *not* blocked: waiting on tokens or budget.** That stays In progress. Nothing
external has to happen — it resumes on its own when the window resets. Calling it blocked would put
budget pauses in the same list as things genuinely needing you, which is exactly the noise we're
removing.

---

## Any status can go to any status

This is a real change from today, and it's the one you asked for.

Today there's a fixed list of allowed moves, and anything not on the list is a hard failure. You can't
go from A to C even when going from A to C is obviously the right thing. The new rule:

> **No move is ever forbidden. But some moves require you to supply something first.**

So instead of *"you can't do that"*, you get *"you can do that, but you have to fill this in."*

| Moving to… | You must supply |
|---|---|
| **Blocked** | Who or what it's waiting on, and why. It has to be something outside the AI system — that's the definition of blocked. |
| **Out of Blocked** | The blocker cleared. You can't leave blocked while still claiming to be blocked. |
| **Completed** | The closing summary — what shipped, what was asked for but not built and why, and where to go look at it. (Details below.) |
| **Completed via `merged`** | Plus the commit, and the review that approved it. Same "no artifact, no review" rule as today, but as a required field rather than a wall. |
| **Backlog, from in-progress** | The agent's claim released first, so nothing keeps trying to resume shelved work. |

Everything the old system blocked is now one of two things: either it was just bookkeeping strictness
and we delete it, or it was protecting something real and it becomes a required field. Nothing that
was actually keeping you safe gets dropped — it changes from a locked door to a form you have to fill
in.

There's also a **preview mode**: an agent can ask "what would happen if I moved this to completed?"
and get back "rejected, you haven't said what wasn't built" without anything actually changing.

---

## The closing summary

We worked this out earlier today, and it's now part of the plan. Nothing can reach **Completed**
without one.

Four things, all short, written for you rather than for the next agent:

- **What shipped** — up to five bullets, one line each, outcomes not steps.
- **What didn't** — anything asked for but not built, each with its reason. This must be filled in
  even if the answer is "nothing" — an empty list you had to write is a statement; a missing field is
  an oversight.
- **What now** — if it's something you can see, where to go and what to click. If it isn't, what was
  actually run and watched working in the real system. ("Tests pass" doesn't count — that describes
  the gate, not the thing.)
- **What to watch for** — anything that might break now.

Plus hard limits the server enforces: bullet counts, line lengths, no copy-pasting the raw work log,
and **no internal jargon** — no `loop-close`, no `§5b`, no script filenames. If it wouldn't survive
being read to you down the phone, it gets rejected.

---

## How agents talk to it: the MCP

**Correction to my earlier framing (you pushed back and you were right).** I said "the front end needs
a web API, therefore the web API is the foundation." That settles how the *front end* talks to it and
nothing else — it shouldn't quietly decide the agents' side too. Those are separate choices.

So, properly:

**The foundation is neither. It's the rules engine in the middle.** All validation lives in one place,
and every way in is an equal door onto it — the web API and the MCP are peers, neither is "the real
one."

**Judged on its own merits, MCP is right for agents.** They get a discoverable list of actions with
proper arguments, no command syntax to memorise, and errors that say what was actually wrong instead
of text to parse. **The web API is right for the front end, and for anything that isn't an MCP
client** — a script, a cron job, curl, or a different AI tool entirely. That last one is what keeps
you unlocked from Claude.

So: one place where all the rules live, and two doors into it.

- **The MCP door** is what agents use. It gives them a tidy list of actions with proper arguments, so
  they don't have to remember command syntax and the errors tell them what was wrong.
- **The web API door** is what the front end uses, and what anything else uses — a script, a cron
  job, curl, or a different AI tool entirely.

That second point matters for the thing you flagged as a safety priority: not getting locked into
Claude. A plain web API works from anything. If you move to Codex or something else later, the app
doesn't care.

**About the ~12 actions the MCP will expose** — deliberately few. One of your existing MCPs
exposes 62 tools, and every one of those descriptions sits in the agent's context on every
single turn whether or not anyone touches it. Small list, kept small on purpose:

*Looking things up:* get one item · list items · what am I working on · **get me oriented** (the
"I'm a fresh session, catch me up" call).
*Changing things:* create · update · **change status** (the validated one) · save a progress note ·
comment · complete.
*Ownership:* claim · release · still-alive ping.
*Crew:* get me a name.

### The MCP "Tasks" feature — you asked whether we can use it. I read the spec.

Your idea was: keep one MCP task open per work item and have the agent fire progress and logs into
it, so later calls carry less. **It doesn't work, for four concrete reasons — but there's a real use
for it elsewhere.**

1. **It runs the wrong way round.** An MCP task tracks work *the server is doing for the agent* —
   you call a tool, it'll take ten minutes, here's a ticket, check back. You want the opposite: the
   *agent* reporting on work *it* is doing. The spec is explicit that only the server creates one.
2. **The agent can't add anything to it.** There's exactly one way for the agent to send something
   into a task, and it only answers questions the *server* asked first. There is no "append a note."
3. **Finished means finished, permanently.** Once a task completes or is cancelled its state can
   never change again. You've just removed exactly that dead end from our design — rework and reopening
   are things we need.
4. **They expire.** Every task carries a time-to-live. Our work items live for weeks.

**And it wouldn't save what you're hoping to save.** The expense in an agent session isn't the size
of each request — it's the tool descriptions sitting in context every turn, and results landing in
context permanently. A ticket number changes neither.

**Where it genuinely fits:** any single operation on *our* side that really does take minutes —
importing your 179 existing task folders, a heavy report. Those should hand back a ticket instead of
making the agent sit and wait. That's precisely what the feature is for, and we should use it there.

**The good news is you already get the thing you wanted.** A durable handle you attach progress to,
that survives disconnects and can be picked up by a fresh session — that's the work item's own ID.
We're building it anyway, and ours is better: it reopens, it never expires, and you can append to it.

---

## The nudge mechanism — and some good news

You asked how a hook that fires on every tool call would work, and whether the MCP can install it.

**I told you an MCP can't install a hook and you'd need a separate step. That's true of an MCP on its
own — but the platform already solves your actual problem, and I should have checked before
designing around it.**

**Claude Code plugins bundle an MCP server and hooks in one installable thing.** A plugin is a folder
containing an MCP configuration, a hooks file, skills, agents, and even executables that get added to
the command path. You install it with one command from a marketplace — and a marketplace can be a
**private repo**, so none of this has to be public. Installing wires up the hooks; nobody hand-edits
a settings file.

**So the seamless flow you wanted already exists.** Agent Standup ships as a plugin: the MCP pointing
at the NAS, the progress hook, and the `standup` command, all in one. One install, fully operational,
exactly as you described — no separate step to know about.

That's also **better than the self-installing handshake I was about to design**, which would have
meant a server sending executable code to your PC to run. Not a risk worth taking when the platform
has a proper answer.

**Your version-sync instinct still stands, though**, just in a safer form. A plugin only updates when
you pull it, so the hook can still drift behind the server. Keep the handshake as a *check*, not a
self-install: the hook reports its version on every call, and if the server needs a newer one it tells
the session to run the update command. Warn, don't self-modify.

**One caveat worth naming: a plugin is a Claude Code format.** Codex wouldn't consume it. So it's a
convenience for the way you work today, and the three pieces inside it — server, hook script, command
— have to stay usable on their own. Nothing about being packaged as a plugin is allowed to leak into
the design.

**And you already have the hook itself.** `fm-tick-inline.ps1` fires after every Bash, PowerShell,
Read, Write, Edit, Grep, Glob and Task call today. The mechanism has been running for weeks — it just
reads and writes files instead of talking to a server.

So the work isn't building a hook. It's **making the existing one a dumb pipe**:

1. Hook fires after a tool call.
2. It sends the server three facts: which session, which task, which tool.
3. The server decides whether to say anything, and sends back text.
4. The hook prints it into the session.

All the thinking moves server-side. And that answers your real question — *"if I update the app, do
the hooks update too?"* **Effectively yes**, because the hook itself never needs to change again. It's
four lines that forward a message. When you want different behaviour — nudge more often, say
something new, stop nudging entirely — you change the server and every machine gets it immediately.

The one thing that still needs a per-machine install is the initial wiring, once. We'll ship a
one-line setup command.

This is also the enforcement you wanted: the server can see an agent has made forty tool calls
without saving a progress note, and say so — rather than hoping the agent remembers.

---

## The front end

Agreed it's not the focus. **Version one is a port of the board you already have** at
the existing board page, reading from the new database instead of markdown files.
That's it.

Everything else goes on the backlog, inside this same repo, as work we intend to do:

- Kanban view — cards you drag between the columns
- Project view — a project and all its tasks
- Progress view
- Expanding a task to see its subtask tree, and clicking into any one of them
- Comments and approvals in the UI

### Backlog — mobile (P3, added 2026-08-10)

**The front end must work properly on a phone, and that almost certainly means a separate mobile
experience rather than a responsive squeeze.** Todo and Kanban apps diverge sharply between desktop
and phone, and the parts that don't translate are exactly the parts we're relying on:

- **Drag-between-columns doesn't work on a phone.** Mobile wants a list with a status picker, or
  swipe actions — not a miniature board.
- **Filters can't live in a sidebar.** Filtering by area, repo, state or assignee needs a sheet or a
  chip row, not a panel.
- **The since-your-last-visit screen is arguably the *primary* mobile case, not an afterthought.**
  It's what you'd do away from the desk — read what merged, tap through to look at it, adjust the
  scores, mark it seen. The scoring sliders in particular have to be thumb-sized.
- **Minting from a phone matters**, because that's where "I've just thought of something" happens.
  It should reach parity with desktop, not be a cut-down capture box.

Nothing here changes the database — it's a front-end concern, and the API already serves it. Recorded
now so the eventual UI work is scoped for two form factors from the start rather than retrofitted.

The database gets designed so the front end can be built later without changing it. That's the main
thing to get right now.

---

## What's generic, what's ours — the full inventory

You asked for the list of everything we support today and want to keep, split by whether another
person building an agent task-tracker would want it. Doing that split turned out to answer the
plugin question by itself.

### Would belong in anyone's agent task tracker

| Feature | Why it's generic |
|---|---|
| Items with title, description, priority, state | Table stakes |
| **Nested items to any depth** | Any agent that discovers work inside work needs this |
| Flat state list, columns worked out from it | Ordinary Kanban |
| Required-fields-on-transition instead of blocked moves | The good idea; nothing user-specific about it |
| History of everything that happened | Table stakes |
| Comments and approvals | Table stakes |
| **Ownership claims with a timeout** | *Every* multi-agent system has the two-agents-one-task bug |
| **Liveness / are-you-still-alive** | Every system where the worker can die mid-job |
| **Progress notes an agent writes as it goes** | The thing that makes continuing possible |
| **"Catch me up" — the orientation call** | Arguably the single most valuable feature here |
| **Forced closing summary** | Generic, and genuinely differentiating |
| Attach evidence to a state change | "No artifact, no review" is a good universal rule |
| Blocked, with who/what and when to check back | Generic |
| Rework counter | Any review loop has rework |
| Open loops / follow-ups | Generic |
| Which repo, which branch, which worktree | Generic *for coding agents*, which is the niche |
| **Since you last looked** | Generic and good — anyone leaving agents running overnight wants it |
| Agent registry, and giving agents names | Generic, and the charming bit |
| Board / Kanban UI | Table stakes |
| MCP, web API, command line | Table stakes |

### Only ever makes sense for the user

| Feature | Why it's ours |
|---|---|
| The ping's specific job list (check inbox → merge queue → dispatch → pull from your Projects note) | Encodes exactly how you work |
| Budget ceilings in Anthropic's 5-hour and weekly pools | Tied to one vendor's billing |
| The 15%-a-day pace line | Your rule, your numbers |
| Cost tracking measured in those pools | Same |
| Model and effort picking (Opus/Sonnet/Haiku) | Claude-specific |
| Standing authorisations as you use them | Your policy |
| Playwright pool slots | A different app entirely |
| The guard hooks (no killing processes, browser guards, delegate nudges) | The user's safety rails |
| Note vault, file-sync, git-sync rules | Your machine setup |
| The Haven dashboard as a render target | Yours |
| The repo list | Yours |
| The chat channel | Yours |

### The pattern that falls out — and it changes my recommendation

Look at the two lists and the difference isn't arbitrary:

> **Everything generic is *storing and checking things*. Everything user-specific is *deciding what
> to do next, and what it costs*.**

That is a much cleaner line than I expected, and it means the answer isn't a plugin system — it's
simpler than that.

**Revised recommendation: the user-specific parts aren't add-ons living inside the app. They're a
separate small program that talks to it — exactly like the front end does.**

The ping becomes its own service: it asks Agent Standup what the state of the world is, applies your
budget rules and your priorities, and tells it what to do. Agent Standup never knows the ping exists.
No plugin machinery, no extension points, no versioned add-on API — just two programs and the web API
that has to exist anyway.

This gets you everything the plugin idea was after:

- The core genuinely cannot grow user-specific assumptions, because that logic isn't in it.
- The core could ship standalone tomorrow — it's already whole without the ping.
- Your rules can change as often as you like without touching the app.
- If you ever move off Claude, the piece that knows about Claude is the small one.

**One correction to my earlier answer:** I'd argued a boundary would break because deciding what to
dispatch needs budget, priority *and* cost history together. That objection goes away here —
cost-per-item is a generic field the core should store anyway, so the ping asks one question and gets
one answer. The line only broke when I drew it in the wrong place.

**Still separate:** not being locked to Claude is a different goal, handled by the core knowing
nothing about any specific AI tool — not by how we package things.
---

## Where it runs

Proposal, and it matches the split we landed on for the browser work:

- **The app runs on the NAS.** It's a small service with a database — exactly what that box is for.
- **Agents keep running on your PC**, and reach out to the app.
- **The app never reaches into your PC.** It doesn't start sessions remotely.

That last one is the safety-relevant bit. The alternative — a server that wakes up and spins up AI
sessions on your machine — was the part you were most uneasy about, and it's the part that's hard to
test properly. Better shape: your PC asks the server "anything for me?", the server answers. The
server can want things to happen; only the PC makes them happen.

---

## Open questions for you

1. **Do projects need statuses at all**, or is a project just a container whose progress is derived
   from the tasks inside it? My instinct is the latter — a project being "in review" doesn't mean
   much.
2. **What happens to the 179 existing task folders.** You said migrate everything, hard cutover,
   including the closed ones. Still your call whether closed tasks come across in full or as
   summaries — the closed ones are the bulk of the volume and the least useful.

---

## What's not in this plan

Not building yet. This is the plan for you to correct. Once you're happy with it, the next step is
breaking it into the actual pieces of work.
