// The override channel — making `block-overridable` actually overridable.
//
// `INTERVENTION_LEVELS` has had four members since the engine shipped:
// `nothing`, `nudge`, `block-overridable`, `hard-block`. Three of them
// worked. The third did not, and the way it failed is worth stating
// precisely, because it is not so much a missing feature as a level that
// quietly meant something other than its name.
//
// ── What was actually broken ────────────────────────────────────────────
//
// Nothing anywhere in the wire protocol carried an override. `HookEvent`
// had no field for one, `decide` had no branch for one, and so a finding
// at `block-overridable` produced exactly the same refusal as one at
// `hard-block`: a deny, with no way past it. The two levels were
// indistinguishable at the only point where the distinction is supposed
// to matter.
//
// The evidence that this was a real cost rather than a tidy gap is that
// two built-in entries have already had their remedies **deleted** because
// of it. `broad-process-kill` and `checkout-held-by-another-crew` both
// used to tell the caller to proceed with a written reason, and both had
// that sentence removed, because it promised an exit no caller could take.
// A guard that names a remedy it then refuses is the worst thing in this
// catalogue — it is the failure the scoring scale's 1 was written for, a
// block someone had to route around — and the fix at the time was to stop
// promising. This module was the other fix: make the promise keepable.
//
// ── What that fix did and did not reach ─────────────────────────────────
//
// The mechanism below works. It is not aspirational and it is not dead
// code: `payload.ts` reads the claim, `decide` honours it, `capture`
// records the outcome, and a raw-stdin test exercises the whole path.
//
// ── Two channels, because one audience cannot reach the other ──────────
//
// The top-level read below is top-level ONLY, deliberately, because an
// override is a statement the caller makes about the guard rather than an
// argument to the tool. That is the right rule and it is load-bearing: if
// an override were an ordinary tool argument, anything that can call a tool
// could waive a guard by adding a field.
//
// It is also a channel only some callers can use. A caller that composes
// its own stdin — a harness, a CLI, a non-Claude-Code client — writes the
// field directly. An **agent** cannot: its only influence over a PreToolUse
// payload is the tool call it makes, which arrives in `tool_input`, and a
// claim nested there is refused by design.
//
// That matters because every `block-overridable` entry in the catalogue is
// `audience: "agent"`. A channel none of them can reach makes the level a
// synonym for `hard-block` at the point where the distinction is supposed
// to apply — and a promise that holds at the protocol layer while failing
// at the delivery layer is worse than making no promise at all, because a
// caller reading the offer has no way to tell the difference and burns
// attempts discovering it.
//
// **`readCommandOverrideClaim` below is the fix, and it keeps the
// principle intact.** It reads a claim from a *marked shell comment* on the
// agent's own command: a construct the tool ignores entirely, carrying a
// marker that exists for no other purpose, which `payload.ts` then lifts to
// the same `HookEvent.override` field a bespoke client's top-level field
// reaches. The agent writes a **claim**; the harness still composes the
// **payload**. What the original rule was protecting — that an override can
// never be an ordinary argument of the tool, so a tool gaining a parameter
// cannot become a way to waive a guard — is preserved exactly, and a claim
// nested in `tool_input` as a field is still refused.
//
// `overrideRemedy` therefore now speaks to both audiences, in two different
// sentences, and is gated on **whether this particular call can carry a
// claim** rather than on the audience alone. That gate is the load-bearing
// part: three of the four entries fire only on `Bash` and can take the
// exit, while `checkout-held-by-another-crew` fires on `Write`/`Edit`/
// `NotebookEdit`, whose every input field is a path or file content, and is
// therefore still told nothing. See `toolCarriesOverride` for why that is a
// structural limit rather than an unfinished corner — a marker there would
// have to be written into the user's file to be sent.
//
// ── Why the module survives that ────────────────────────────────────────
//
// Because the channel is still correct for a caller that composes its own
// stdin: the test harness, a non-Claude-Code hook client, a future CLI. A
// capability with no current consumer in one deployment is not a broken
// promise; a promise printed to an audience that cannot act on it is. Only
// the second was removed. Do not "finish the cleanup" by deleting this
// module — the raw-stdin test in `tests/hook-run.test.ts` is the guard
// proving it still works, and it is meant to stay green.
//
// ── Block-and-record, not block-and-argue ───────────────────────────────
//
// MILESTONES.md #128 frames this tier as **block-and-record**, and is
// blunt about why: an agent asked to justify itself will always produce a
// justification, so the value is the recorded reason on a reviewable
// event, not the friction.
//
// That framing decides essentially every design question here, and mostly
// by telling us **not** to do things. There is no adjudication of whether
// a reason is good, because there could not be one — no rule can tell a
// considered justification from a merely fluent one, and a check that
// tried would only teach callers to write longer. There is no allowance
// list of acceptable reasons, no reviewer in the loop, no escalation. An
// override succeeds on being *written down and attributed*, and the
// control is that somebody can read it afterwards beside the call it
// excused.
//
// What that leaves worth enforcing is small, and this module holds all of
// it: an override must name **which** finding it overrides, must carry a
// reason with content in it, and must never reach a `hard-block`.
//
// ── Where the record actually happens ──────────────────────────────────
//
// **Not here.** This module decides; it stores nothing and reaches no
// database, in keeping with the rest of `src/lib/hook/`. The claim above
// that the reason is recorded is made good by the path out of it:
// `./decide.ts` returns the honoured override on `HookVerdict.override`,
// `./run.ts` hands it to `onFindings`, and `../interventions/capture.ts`
// turns it into a row with `outcome: "overridden"` and the reason on
// `override_reason`.
//
// That chain is named explicitly because for one release it did not exist.
// The tier shipped with this header already promising a reviewable record,
// while the reason reached only the verdict string that is printed to
// stderr and discarded — so `InterventionOutcome.overridden`, which the
// schema's own comment calls the most diagnostic outcome on its list, was
// a value no code could produce. A comment asserting a guarantee the code
// does not provide is worse than no comment: it ends the search for the
// gap. If the chain above is ever broken again, this paragraph is the one
// to correct rather than to leave standing.
//
// ── The one thing it must never do ──────────────────────────────────────
//
// A `hard-block` is not overridable. That is the whole difference between
// the two blocking levels, and it is enforced here by a function that
// cannot express the alternative: `overrideApplies` returns false for
// `hard-block` before it looks at anything else. A caller can send a
// perfectly-formed override for a hard block and be refused anyway, which
// is the correct and intended outcome.
//
// This is deliberately *not* left to the caller to respect. The service
// side learned the same lesson with `merge_override`, which is scoped so
// it can never satisfy the human-authorisation clause however it is
// written: an escape hatch is only safe when its limits are structural
// rather than advisory.

import {
  isBlockingLevel,
  type InterventionAudience,
  type InterventionLevel,
} from "../interventions/types";

/**
 * The shortest reason that counts as having said something.
 *
 * Twenty characters, deliberately matching `MIN_REASON_LENGTH` on the
 * service side's `merge_override`: the same judgement is being made about
 * the same kind of statement, and two different floors would mean an
 * override accepted by the hook and refused by the service — precisely the
 * "do the right thing and still be refused" split this system already has
 * one of.
 *
 * A length floor is a crude proxy and does not pretend otherwise: it cannot
 * tell a considered sentence from forty characters of keyboard. What it
 * removes is the one-character reason, which is the form a mandatory field
 * collapses into when nothing checks it. A real reason clears it
 * comfortably; a dismissal does not.
 */
export const MIN_OVERRIDE_REASON_LENGTH = 20;

/**
 * The longest reason that is stored.
 *
 * Bounded because this reaches a database column and rides the hook's
 * critical path, and unbounded free text on both is how a guard becomes the
 * slowest thing in a session. Generous enough that nobody hits it while
 * writing an honest sentence.
 */
export const MAX_OVERRIDE_REASON_LENGTH = 1000;

/** An override as a caller sends it. */
export interface OverrideClaim {
  /**
   * The entry being overridden, e.g. `broad-process-kill`.
   *
   * Required, and this is the field that makes an override a statement
   * rather than a mood. A blanket claim to have a reason would let one
   * written justification excuse every finding on a call — including one
   * the caller never read, and including one that fires later for a
   * different reason. Naming the entry scopes an override to the thing the
   * caller actually looked at, the way `merge_override` is scoped to the
   * commit it was written about rather than standing forever.
   */
  readonly entryId: string;
  /** Why the caller believes proceeding is right. Recorded verbatim. */
  readonly reason: string;
}

/** Why an override was not honoured, in words a caller can act on. */
export type OverrideRefusal =
  "no-override" | "wrong-entry" | "reason-too-short" | "level-not-overridable";

/**
 * Whether an override lets this finding through.
 *
 * The refusals are kept separate rather than collapsed into a boolean
 * because they need different things said back: not sending one, sending
 * one for a different finding, and a finding that cannot be overridden at
 * all are three different next actions, and a caller told only that it was
 * refused would retry the wrong one.
 */
export interface OverrideOutcome {
  readonly applies: boolean;
  readonly refusal?: OverrideRefusal;
  /** The reason, trimmed, when the override stands. */
  readonly reason?: string;
}

/**
 * Whether `claim` overrides a finding on `entryId` at `level`.
 *
 * **`hard-block` is checked first and unconditionally.** Everything after
 * that line concerns a `block-overridable`; nothing after it can reach a
 * hard block, whatever it is sent.
 *
 * A non-blocking level (`nudge`, `nothing`) also yields `applies: false`,
 * and that is not a refusal in any meaningful sense — there was nothing to
 * override, because nothing was being blocked. Callers read `applies` for
 * the decision and consult `refusal` only when something was actually
 * stopped.
 */
export function overrideApplies(
  claim: OverrideClaim | undefined,
  entryId: string,
  level: InterventionLevel,
): OverrideOutcome {
  // Unconditional and first. A hard block is refused before the claim is
  // examined at all, so no property of a well-formed override can reach it.
  if (level === "hard-block") {
    return { applies: false, refusal: "level-not-overridable" };
  }

  // Nothing was blocked, so there is nothing to override. Not a refusal.
  if (!isBlockingLevel(level)) return { applies: false };

  if (claim === undefined) return { applies: false, refusal: "no-override" };

  // Scoped to the named entry. An override written for one finding does not
  // excuse a different one that happened to fire on the same call.
  if (claim.entryId !== entryId) return { applies: false, refusal: "wrong-entry" };

  const reason = claim.reason.trim();
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
    return { applies: false, refusal: "reason-too-short" };
  }

  return { applies: true, reason: reason.slice(0, MAX_OVERRIDE_REASON_LENGTH) };
}

/**
 * Reads an override claim off an arbitrary value — a field on a hook
 * payload.
 *
 * Returns `undefined` for anything malformed rather than throwing or
 * partially accepting. **The direction of that failure is the point**: a
 * garbled override reads as *no override*, so the call stays blocked. The
 * opposite bias — treating an unreadable claim as good enough — would let a
 * malformed payload open the gate, which is the one way an escape hatch
 * turns into a bypass.
 */
export function readOverrideClaim(value: unknown): OverrideClaim | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const entryId = record.entryId ?? record.entry_id;
  const reason = record.reason;

  if (typeof entryId !== "string" || entryId.trim() === "") return undefined;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;

  return { entryId: entryId.trim(), reason: reason.trim() };
}

/**
 * The marker that introduces an override written into a shell command.
 *
 * Exported so the refusal text and the parser cannot drift: `overrideRemedy`
 * builds its printed syntax from this constant rather than spelling it a
 * second time, and a test parses the printed sentence back through
 * `readCommandOverrideClaim`. A remedy that advertises a form the parser
 * rejects is the defect this whole module's history is about.
 */
export const COMMAND_OVERRIDE_MARKER = "standup-override";

/**
 * The tools whose input carries a field an override can be written into.
 *
 * **`Bash` and nothing else, and that is a finding rather than a
 * shortcut.** The claim has to live somewhere the agent controls, that
 * reaches the hook, and that is not the content of the user's work. On a
 * `Bash` call the command line is all three: a trailing comment is inert to
 * the shell, fully chosen by the caller, and already read by
 * `payload.ts`.
 *
 * No other tool this build blocks on has such a field.
 * `checkout-held-by-another-crew` — the fourth `block-overridable` entry —
 * fires only on `Write`, `Edit` and `NotebookEdit`
 * (`CHECKOUT_WRITE_TOOLS` in `../interventions/context.ts`, which excludes
 * `Bash` deliberately), and every field of those tools' input is either a
 * path or the file content being written. A marker placed there would have
 * to be **written into the user's file** in order to be transmitted, which
 * is a content mutation dressed up as a protocol. That entry therefore has
 * no command-borne override, it is not given a remedy that pretends
 * otherwise, and the reason is recorded here rather than left for the next
 * reader to rediscover.
 */
const COMMAND_OVERRIDE_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/**
 * Whether a tool's call can carry an override in its own input.
 *
 * Used both by the parser and by `overrideRemedy`, so an entry that cannot
 * receive a claim is never told to send one. The two questions are the same
 * question and are answered by one function on purpose.
 */
export function toolCarriesOverride(tool: string | undefined): boolean {
  return tool !== undefined && COMMAND_OVERRIDE_TOOLS.has(tool);
}

/**
 * Matches an override claim written as a trailing shell comment.
 *
 * ── Every part of this pattern is load-bearing ─────────────────────────
 *
 * `(?:^|\r?\n)` — the claim must begin a line, and this is **stricter than
 * a shell on purpose.** `echo x # standup-override(e): …` is a perfectly
 * valid trailing comment to `sh`, and it is refused here anyway, because
 * this reader sees *text* rather than a parsed command: it cannot
 * distinguish that from `echo "x # standup-override(e): …"`, where the
 * marker is an argument the caller is printing. A `#` mid-command is
 * frequently not a comment at all — a URL fragment, `--format=#%h`, a
 * quoted string — and reading one as a claim would find an override in a
 * command that made none. Requiring its own line removes that entire class
 * of ambiguity for the price of one newline, and `overrideRemedy` prints
 * the form that works so nobody has to discover this by being refused.
 *
 * `[ \t]*#[ \t]*` — an ordinary shell comment, allowing the indentation a
 * multi-line command naturally has.
 *
 * `\(([^)\r\n]+)\)` — the entry id, parenthesised. Required, not optional:
 * an override names **which** finding it excuses, and a bare marker with a
 * reason would be the blanket claim `OverrideClaim.entryId` exists to
 * prevent.
 *
 * `$` with the `s`-less flag set and a `[^\r\n]*` tail — the claim runs to
 * the end of its line and no further.
 *
 * **Anchored at the END of the command.** This is the property that makes
 * the negative case hold: a command that merely *mentions* the marker —
 * `grep -rn "standup-override" src/`, or a heredoc writing this very
 * documentation into a file — has the mention somewhere other than its
 * final line, so it does not match. A caller who genuinely wants to
 * override puts the comment last, which is also where a trailing comment
 * naturally goes.
 */
const COMMAND_OVERRIDE_PATTERN = new RegExp(
  `(?:^|\\r?\\n)[ \\t]*#[ \\t]*${COMMAND_OVERRIDE_MARKER}\\(([^)\\r\\n]+)\\)[ \\t]*:[ \\t]*([^\\r\\n]*)[ \\t]*$`,
);

/**
 * Reads an override claim out of a tool call the agent composed itself.
 *
 * ── Why this exists alongside the top-level read ───────────────────────
 *
 * The top-level `standup_override` field is correct and stays. It is also
 * unreachable for every caller that meets a `block-overridable` finding:
 * all four such entries are `audience: "agent"`, and an agent contributes
 * nothing to a `PreToolUse` payload except `tool_input`. Measured over the
 * life of the deployment, that gap reads as **448 blocks against 7
 * overrides**, and the seven are probes and the test harness — not one
 * agent has ever taken an exit the level's own name advertises.
 *
 * ── The principle this preserves, which is the delicate part ───────────
 *
 * The module header's rule is that *an override is a statement the caller
 * makes about the guard rather than an argument to the tool*, and that rule
 * is why the top-level read refuses a claim nested in `tool_input`. This
 * function does not weaken it. What it reads is not a tool argument: it is
 * a **shell comment**, a construct with no meaning to the tool at all,
 * carrying a marker that exists for no purpose but this one. The agent
 * writes a *claim*; the harness still composes the *payload*; `payload.ts`
 * lifts the claim to the same top-level `HookEvent.override` field the
 * bespoke channel populates, and `decide` cannot tell which arrived.
 *
 * The distinction that actually mattered is preserved exactly: an override
 * still cannot be an ordinary field of the tool's own input, so a tool
 * gaining a new parameter can never accidentally become a way to waive a
 * guard.
 *
 * ── The failure direction is unchanged ─────────────────────────────────
 *
 * Anything that does not match cleanly yields `undefined`, which reads as
 * *no override* and leaves the call blocked. A too-short reason is left to
 * `overrideApplies` rather than rejected here, so that the caller is told
 * *"your reason was too short"* instead of *"you sent no override"* — two
 * different next actions, and the refusal machinery already distinguishes
 * them.
 */
export function readCommandOverrideClaim(
  tool: string | undefined,
  command: string | undefined,
): OverrideClaim | undefined {
  if (!toolCarriesOverride(tool)) return undefined;
  if (command === undefined) return undefined;

  const match = COMMAND_OVERRIDE_PATTERN.exec(command);
  if (match === null) return undefined;

  const entryId = match[1]?.trim();
  const reason = match[2]?.trim();

  if (entryId === undefined || entryId === "") return undefined;
  // An empty reason is no claim at all. A *short* one is a claim that
  // `overrideApplies` refuses by name — the distinction above.
  if (reason === undefined || reason === "") return undefined;

  return { entryId, reason };
}

/**
 * What to tell a caller whose blocked call could have been overridden.
 *
 * **Two sentences, chosen by what the caller can actually send.** That is
 * the whole shape of this function, and the history below is why it is that
 * rather than something simpler.
 *
 * ── The regression this function was once emptied to fix ───────────────
 *
 * It used to return one generic sentence for every `block-overridable`
 * finding, telling the caller to re-run the call with an override naming
 * the entry and a written reason. That sentence was true about the protocol
 * and false about its audience. The channel existed and worked — a
 * top-level `standup_override`, honoured by `decide`, recorded by
 * `capture` — but every `block-overridable` entry is `audience: "agent"`,
 * and an agent's only influence over the payload is the tool call it makes.
 * So the offer was unkeepable by everyone it was ever shown to. Two
 * sessions lost a merge phase to it, one spending seven attempts inventing
 * syntaxes that could not have worked, and the function was emptied to stop
 * the lie.
 *
 * Silence is the right answer only while the reader genuinely has no way to
 * send a claim. Once `readCommandOverrideClaim` above gives an agent one,
 * staying silent becomes the same defect pointing the other way — withholding
 * a syntax that works, from the only audience that ever needs it. Both
 * failures come from the same mistake: deciding what to say from a general
 * fact about the audience rather than from what this call can actually do.
 *
 * ── Why the gate is the TOOL, not the audience ─────────────────────────
 *
 * The obvious fix — delete the audience check — is the original bug wearing
 * new clothes, because it would hand the comment syntax to a reader whose
 * call cannot carry a comment. `checkout-held-by-another-crew` is exactly
 * that reader: it fires only on `Write`, `Edit` and `NotebookEdit`, whose
 * every input field is a path or file content.
 *
 * So the question asked here is the one the audience check was always a
 * proxy for: **can this particular call carry a claim?** For an
 * `orchestrator` — a harness, a CLI, a non-Claude-Code client composing its
 * own stdin — the answer is yes by construction, and it keeps the top-level
 * form, which is the one it can actually use. For everyone else the answer
 * is `toolCarriesOverride`, so an agent on a `Bash` call is told the
 * comment syntax and an agent on an `Edit` is told nothing at all.
 *
 * ── Both sentences are pinned to their parsers ─────────────────────────
 *
 * Neither is paraphrased from memory. The orchestrator form names
 * `standup_override` with `entryId`/`reason`, which is what
 * `readOverrideClaim` accepts at the top level of the stdin JSON. The agent
 * form is built from `COMMAND_OVERRIDE_MARKER`, and a test in
 * `tests/hook-override.test.ts` extracts the printed line, substitutes a
 * real reason, and feeds it back through `readCommandOverrideClaim` — so a
 * change to the marker or the punctuation on either side fails loudly
 * rather than advertising a form the parser rejects.
 *
 * ── What the agent sentence says beyond the syntax ─────────────────────
 *
 * Two things, both deliberate. It frames the block as a prompt to stop and
 * think rather than a wall, which is what this tier actually is
 * (MILESTONES.md #128's block-and-record), and it says plainly that the
 * reason is kept as a record and not checked for correctness — an honest
 * description beats implying an adjudication that does not happen. And it
 * names where to file feedback, because an agent that thinks the *entry* is
 * wrong has something better to do than override it repeatedly.
 *
 * @returns the override sentence for an overridable finding whose audience
 * can supply one, and `null` otherwise — including for every `hard-block`,
 * which no payload can override at any level.
 */
export function overrideRemedy(
  entryId: string,
  level: InterventionLevel,
  audience?: InterventionAudience,
  tool?: string,
): string | null {
  // A hard block is not overridable by anyone, so there is no syntax to
  // offer. Checked first and unconditionally, mirroring `overrideApplies`.
  if (level !== "block-overridable") return null;

  // The bespoke-client reader keeps the channel it can actually use. This
  // branch is unchanged in substance: a caller composing its own stdin
  // writes the field directly, and telling it to write a shell comment
  // instead would be handing it the long way round to the same place.
  if (audience === "orchestrator") {
    return (
      `If proceeding is right, re-send this call with a top-level "standup_override": ` +
      `{"entryId": "${entryId}", "reason": "..."} field on the hook payload — top level, not ` +
      `inside tool_input, where it is refused. The reason is recorded verbatim beside the call ` +
      `and must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters.`
    );
  }

  // Every other reader — `agent`, and an `undefined` audience, which is
  // treated as an agent for the reason the emptied version of this
  // function already gave: an unknown reader is far likelier to be one.
  //
  // **Gated on the tool, not merely on the audience.** This is the
  // safeguard that keeps the original regression from recurring in a new
  // form. The history here is a sentence that was true about the protocol
  // and false about its reader; repeating that with a comment syntax would
  // be the same defect wearing different clothes. So the offer is made only
  // when this specific call can actually carry a claim — and for the one
  // `block-overridable` entry that fires on tools which cannot
  // (`checkout-held-by-another-crew`, on `Write`/`Edit`/`NotebookEdit`),
  // nothing is offered and the entry's own remedy stands alone.
  if (!toolCarriesOverride(tool)) return null;

  return (
    `This block is a prompt to stop and think, not a wall: if you judge that this guard does ` +
    `not apply to what you are doing, you may proceed by saying why. Re-run the same command ` +
    `with the override appended on a line of its own — the newline is required, a comment ` +
    `sharing a line with the command is not read — exactly like this:\n` +
    `# ${COMMAND_OVERRIDE_MARKER}(${entryId}): <why this guard does not apply here>\n` +
    `The reason must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters. It is recorded ` +
    `verbatim beside this call and is reviewable afterwards — kept as a record, not checked ` +
    `for correctness. If the guard itself is wrong rather than merely inapplicable, that is ` +
    `worth more than an override: file it in haven-assistant/agent-standup/feedback/.`
  );
}
