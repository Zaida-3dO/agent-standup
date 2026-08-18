// `kill_guard` — MILESTONES.md #45's "the kill guard as an **ownership
// check**", DECISIONS.md §4 ("Why the kill guard exists").
//
// One command in, one resolved verdict out. Deliberately **allow or deny,
// never `ask`**, and that is not a stylistic choice. `hook_decision` answers
// `ask` for an ask-list match and the hook reads `ask` as a deny, so a guard
// expressed as an ask-list pattern is a guard that denies everything it
// matches — including the ordinary case of a crew killing its own dev
// server. An ownership check has all the information it needs the moment it
// is asked; there is nothing to defer to, so it resolves.
//
// ── What this operation does NOT do ────────────────────────────────────
//
// It does not decide whether the command is a kill *and also* whether the
// caller is allowed to run kills at all, and it does not consult the
// pattern lists. A command that is not a kill is `allow` with a stated
// reason, and the hook goes on to classify it normally. Overloading this
// with a second question would make the answer un-attributable: "denied"
// would mean either "not yours" or "not allowed", and the agent reading it
// could not tell which.
//
// ── Fail-closed, and where the line actually is ────────────────────────
//
// Three distinct refusals, all of them deliberate, none of them the same
// mistake:
//
//   1. **Unparseable kill.** A kill-shaped command this build cannot
//      decompose (`taskkill /FI "…"`, `pkill -f`). Denied — an unread
//      selector is not an empty one.
//   2. **Unregistered target.** Denied, because unknown is not unowned.
//   3. **Foreign target.** Denied, and this is the case the row exists for.
//
// And exactly one allow that is easy to misread as a hole: a kill of a pid
// **your own crew registered** is allowed even when it is `-9`, even when
// there are several. Blast radius, not violence, is what this guard is
// about.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseKillCommand } from "@/lib/kill/parse";
import {
  checkOwnership,
  refusalMessage,
  type OwnershipObjection,
  type RegisteredProcessView,
} from "@/lib/kill/ownership";

const inputSchema = z
  .object({
    /** The command text, exactly as the hook observed it. */
    command: z.string(),
    /** Where it would run. A pid means nothing without it. */
    machine: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    /** The asking session's crew root. Defaults to the session itself. */
    rootSessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export type KillGuardInput = z.infer<typeof inputSchema>;

export interface KillGuardOutput {
  readonly decision: "allow" | "deny";
  /** The sentence the agent reads. Always present, including for an allow. */
  readonly reason: string;
  /**
   * Why the verdict came out that way, as a value rather than prose.
   *
   * Kept separate from `reason` because these are operationally different
   * problems that read identically in a sentence: `not-a-kill` is the
   * common case and means nothing was guarded, `unparseable` means the
   * guard could not read the command and a pattern may need widening, and
   * `unowned` means the guard did its job. A caller that can only see the
   * message cannot count them apart.
   */
  readonly basis: "not-a-kill" | "owned" | "unowned" | "unparseable";
  /** Present for `unowned`. One entry per target that failed the check. */
  readonly objections?: readonly OwnershipObjection[];
}

interface LiveRow {
  pid: number;
  executable: string;
  root_session_id: string;
  description: string | null;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const killGuard = defineOperation({
  name: "kill_guard",
  kind: "read",
  summary:
    "Decides whether a kill command would end only processes the asking session's crew registered.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: KillGuardInput): Promise<KillGuardOutput> {
    const parsed = parseKillCommand(input.command);

    if (parsed.kind === "not-a-kill") {
      return {
        decision: "allow",
        reason: "this command does not end any process, so there is no ownership to check",
        basis: "not-a-kill",
      };
    }

    if (parsed.kind === "unparseable") {
      return {
        decision: "deny",
        reason:
          `This command would end processes, but ${parsed.reason}. ` +
          `Name the processes to end by process id instead, so this check can tell whose they are.`,
        basis: "unparseable",
      };
    }

    const rootSessionId = input.rootSessionId ?? input.sessionId;

    // Only the asking machine's live rows. A pid is unique per host, so
    // rows from another machine could only ever produce a false match —
    // and a false match on a foreign machine's row would refuse a kill that
    // was entirely the caller's own.
    const rows = await ctx.db.$queryRawUnsafe<LiveRow[]>(
      `SELECT "pid", "executable", "root_session_id", "description"
       FROM "registered_processes"
       WHERE "machine" = $1 AND "endedAt" IS NULL`,
      input.machine,
    );

    const live: RegisteredProcessView[] = rows.map((row) => ({
      pid: row.pid,
      executable: row.executable,
      rootSessionId: row.root_session_id,
      description: row.description,
    }));

    const answer = checkOwnership({ rootSessionId, targets: parsed.targets, live });

    if (answer.owned) {
      return {
        decision: "allow",
        reason: "every process this would end was registered by this session's own crew",
        basis: "owned",
      };
    }

    return {
      decision: "deny",
      reason: refusalMessage(answer),
      basis: "unowned",
      objections: answer.objections,
    };
  },
});
