// The ownership check — MILESTONES.md #45's whole point, and the reason it
// is a row rather than a pattern in `hook.ask_patterns`.
//
// DECISIONS.md §4: "It is also the better place for it: the server can do an
// **ownership check** — is that PID yours? — where a local rule could only
// pattern-match. Requires agents to register processes they start."
//
// ── The question, stated exactly ───────────────────────────────────────
//
// Not "is this command dangerous". Not "does this look like a machine-wide
// kill". The question is: **would running this end a process that this
// session's crew did not start?** That framing is what makes the answer
// useful rather than annoying. `taskkill /IM node.exe` on a machine where
// your crew owns the only two node processes is harmless and is allowed
// here; the identical command on a machine where a sibling agent has a
// dev server running is the exact damage §4 describes, and is refused —
// **and a pattern match cannot tell those two apart, because the command
// text is byte-for-byte identical.**
//
// The corollary is the part worth being careful about: a *narrower* command
// is not automatically safer. `kill 4821` is refused when 4821 belongs to
// someone else, and allowed when it belongs to you. Nothing about the shape
// of the command decides it.
//
// ── Why the comparison is on the ROOT session ──────────────────────────
//
// A crew is an orchestrator plus its builders plus its reviewers, and they
// share a `rootSessionId` (SCHEMA.md §2, which denormalises it precisely so
// "is this session part of the crew on X" is one comparison). An
// orchestrator killing the dev server its own builder registered is the
// ordinary case, not an intrusion — so ownership is a root comparison, and
// a per-session comparison would refuse it and make the guard something
// agents route around.
//
// ── Unregistered processes, and why they refuse ────────────────────────
//
// The registry only knows what was declared. A pid nobody registered is
// therefore *unknown*, not *unowned* — and the two are indistinguishable
// from here. It refuses, on the same rule as everything else in the hook
// path: "denies when unsure". The refusal names the fix (register it), so
// the cost of the strictness is one call, paid by the agent that started
// the process rather than by whoever it would have been killed under.
//
// This is deliberately the strictest of the three plausible readings, and
// it is worth saying which the others were: allowing an unregistered pid
// would make the guard trivially bypassable (never register, kill freely),
// and allowing it only when the registry is *entirely* empty would make the
// guard's strictness depend on unrelated activity elsewhere on the machine
// — the same command allowed at 09:00 and refused at 09:05 because a
// different crew started a process in between.

import type { KillTarget } from "./parse";

/**
 * One live registration, as the check needs to see it.
 *
 * Deliberately a plain shape rather than the Prisma row: this function is
 * the judgement and takes no database, so its refusals are testable as
 * values-in, verdict-out with nothing seeded.
 */
export interface RegisteredProcessView {
  readonly pid: number;
  readonly executable: string;
  readonly rootSessionId: string;
  readonly description?: string | null;
}

export interface OwnershipQuestion {
  /** The root of the asking session's tree. */
  readonly rootSessionId: string;
  /** What the command would kill. */
  readonly targets: readonly KillTarget[];
  /** Every live registration on the asking machine. */
  readonly live: readonly RegisteredProcessView[];
}

/** Why one target was refused. */
export interface OwnershipObjection {
  readonly target: KillTarget;
  readonly kind: "unregistered" | "owned-by-another";
  readonly detail: string;
}

export interface OwnershipAnswer {
  readonly owned: boolean;
  readonly objections: readonly OwnershipObjection[];
}

/**
 * Whether every target belongs to the asking crew.
 *
 * **An empty target list is NOT ownership.** A caller reaching here with
 * nothing to check has either parsed a command wrongly or asked a question
 * about nothing, and answering "yes, you own all zero of them" turns either
 * mistake into an allow. It refuses, with an objection saying so.
 */
export function checkOwnership(question: OwnershipQuestion): OwnershipAnswer {
  if (question.targets.length === 0) {
    return {
      owned: false,
      objections: [
        {
          target: { kind: "executable", value: "" },
          kind: "unregistered",
          detail:
            "the command was reported as a kill but named nothing this build could resolve, so " +
            "ownership cannot be established for anything it would end",
        },
      ],
    };
  }

  const objections: OwnershipObjection[] = [];

  for (const target of question.targets) {
    const matches =
      target.kind === "pid"
        ? question.live.filter((row) => String(row.pid) === target.value)
        : question.live.filter((row) => row.executable === target.value);

    if (matches.length === 0) {
      objections.push({
        target,
        kind: "unregistered",
        detail:
          target.kind === "pid"
            ? `no live process is registered with pid ${target.value} on this machine, so this build cannot tell whose it is`
            : `no live process running ${target.value} is registered on this machine, so this build cannot tell how many others this would end`,
      });
      continue;
    }

    const foreign = matches.filter((row) => row.rootSessionId !== question.rootSessionId);
    if (foreign.length > 0) {
      objections.push({
        target,
        kind: "owned-by-another",
        detail:
          target.kind === "pid"
            ? `pid ${target.value} was registered by another session's crew`
            : `${foreign.length} live ${target.value} process${foreign.length === 1 ? "" : "es"} belong${foreign.length === 1 ? "s" : ""} to another session's crew, and this command would end ${foreign.length === 1 ? "it" : "them"} too`,
      });
    }
  }

  return { owned: objections.length === 0, objections };
}

/**
 * The sentence a refused agent reads.
 *
 * Written to be actionable rather than merely correct: it names what would
 * have died, whose it is, and the one thing that would make the call
 * succeed. An agent that reads "denied" and nothing else retries into the
 * same wall, which costs more than the guard saves.
 */
export function refusalMessage(answer: OwnershipAnswer): string {
  const reasons = answer.objections.map((objection) => objection.detail).join("; ");
  const hasUnregistered = answer.objections.some((objection) => objection.kind === "unregistered");

  const advice = hasUnregistered
    ? "Register the processes your session starts (`register_process`) so this check can tell them apart from everyone else's, then retry. If the process is not yours, target only your own by process id."
    : "Target only the processes your own session started, by process id.";

  return `This kill would reach past your own session: ${reasons}. ${advice}`;
}
