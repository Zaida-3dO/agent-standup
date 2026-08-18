// `/setup-agent-standup` — register the poller's scheduled task, then prove
// it works with a live call (MILESTONES.md #49, DECISIONS.md §10).
//
// ── The proof is the row, not a flourish ────────────────────────────────
//
// §10 states the requirement as "must **verify, not just install**:
// register → trigger one poll → confirm the server saw it". The failure it
// exists to prevent is specific and quiet: a scheduled task registers
// successfully, reports success, and never fires — wrong principal, a
// launcher path that does not resolve, an execution policy that refuses the
// script. Every one of those produces a *registered* task and a machine
// that polls nothing, and none of them is visible from the registration's
// own exit code. A setup step that stops at "registered" therefore leaves
// an installation believing it is protected when it is not, which is
// exactly the state this product exists to make impossible.
//
// So the outcome type below has no success value that means "registered".
// It reports `verified` only when a call reached the server and the server
// answered, and `registerScheduledTask` on its own cannot produce that
// value — the verification step is the only thing that can, which is what
// makes the proof structural rather than a step someone might skip.
//
// ── Why this file registers nothing itself ──────────────────────────────
//
// Every decision here is a value in and a value out: which command would be
// run, and what an answer means. Nothing in this module spawns a process,
// touches the OS scheduler or opens a socket — the caller supplies both as
// injected functions. That is what lets the whole of it be tested on a
// machine that ends the run with no scheduled task on it, which CLAUDE.md
// requires of anything that touches the host and which a test that actually
// registered one could not honour.

import { PACKAGE_NAME } from "./manifest";

/** The name the poller's scheduled task is registered under. */
export const TASK_NAME = "AgentStandupPoller";

/**
 * How often the poller asks the server what to launch.
 *
 * Five minutes, matching the sweep scheduler's interval and chosen against
 * the same tradeoff: the cost of a tick is one request that usually finds
 * nothing, while the cost of a long gap is however long a machine goes
 * without picking up work that is waiting for it. The second side
 * dominates, so the interval is short.
 */
export const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * The scheduling principal, settled by the spike in
 * `docs/spikes/unattended-windows-launch/`.
 *
 * `Interactive` attaches to the existing logon session, so the task keeps
 * firing while the machine is locked; `Limited` means no elevation and no
 * stored credential. The alternative that survives a full logoff runs in
 * Session 0, which has no desktop or window station — it sounds like the
 * more robust setting and is a different tool, not a safer variant. The
 * spike's mechanism table carries the full comparison.
 */
export const LOGON_TYPE = "Interactive";
export const RUN_LEVEL = "Limited";

/**
 * The command the scheduled task runs on every tick.
 *
 * `standup sweep`, whose own alias exists for exactly this caller: "it is
 * not a command a person types daily, it is the command a **scheduler**
 * invokes ... a cron entry, a scheduled task" (`commands-ownership.ts`).
 * Registering the short form is what that alias is for, and it keeps the
 * registered command line legible to whoever reads it out of context much
 * later, which is the only way a scheduled task is ever read.
 */
export const TASK_VERB = "sweep";

/** What a setup run is asked to do. */
export interface SetupInputs {
  /** Where the server is. Required: there is nothing to verify against without it. */
  readonly standupUrl?: string;
  /** The machine this installation is for, as the server records it. */
  readonly machine?: string;
  /** The session running setup, which is also the session the live call proves. */
  readonly sessionId?: string;
  readonly taskName?: string;
  readonly intervalMinutes?: number;
}

/** The command line a registration would run, resolved but not executed. */
export interface ScheduledTaskPlan {
  readonly taskName: string;
  readonly intervalMinutes: number;
  readonly logonType: string;
  readonly runLevel: string;
  /** The executable the task runs, and its arguments — the poller, out of the installed package. */
  readonly execute: string;
  readonly arguments: readonly string[];
}

/**
 * Resolves what would be registered, without registering it.
 *
 * Separated from the registration itself so the plan can be asserted, shown
 * to a person before anything is changed, and compared against a task
 * already on the machine. A function that only registered would make "what
 * is about to happen on this host" answerable exclusively by doing it.
 *
 * The task runs the package's own binary rather than a path into an install
 * directory, for the reason `manifest.ts` gives about the hook command: a
 * path assumes a layout that differs per package manager, and the plugin
 * does not choose where it is installed.
 */
export function planScheduledTask(inputs: SetupInputs = {}): ScheduledTaskPlan {
  return {
    taskName: inputs.taskName ?? TASK_NAME,
    intervalMinutes: inputs.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    logonType: LOGON_TYPE,
    runLevel: RUN_LEVEL,
    execute: "npx",
    arguments: ["--no-install", "-p", PACKAGE_NAME, "standup", TASK_VERB],
  };
}

/** Why a setup run stopped short of a proof. */
export type SetupFailureStage = "unconfigured" | "register" | "verify";

export interface SetupFailure {
  readonly ok: false;
  readonly stage: SetupFailureStage;
  readonly message: string;
  /** Present when registration succeeded and it was the proof that failed. */
  readonly registered?: boolean;
}

export interface SetupSuccess {
  readonly ok: true;
  readonly taskName: string;
  readonly intervalMinutes: number;
  /**
   * Always `true` on this branch, and it is not redundant.
   *
   * It is the field a caller reads to answer "did anything actually reach
   * the server", and having it exist only on the success branch is what
   * makes the answer unforgeable: there is no shape of this type that says
   * registered-but-unproven.
   */
  readonly verified: true;
  /** What the server reported back, so the proof is legible rather than a boolean. */
  readonly server: { readonly hookVariant?: string; readonly protocolVersion?: number };
}

export type SetupResult = SetupSuccess | SetupFailure;

/** Registers the task. Supplied by the caller; never implemented in this module. */
export type RegisterFn = (plan: ScheduledTaskPlan) => Promise<{ ok: boolean; message?: string }>;

/** Makes one live call and reports what the server said. */
export type VerifyFn = (inputs: {
  readonly standupUrl: string;
  readonly machine: string;
  readonly sessionId: string;
}) => Promise<{
  ok: boolean;
  message?: string;
  hookVariant?: string;
  protocolVersion?: number;
}>;

/**
 * Runs setup: register, then prove.
 *
 * **The order is load-bearing and the early return is the point.** Verifying
 * before registering would prove only that a server is reachable, which was
 * already true before setup ran and says nothing about the task. Verifying
 * after is what ties the two together — the call is made by the thing that
 * was just installed, so an answer means the installation works rather than
 * that the network does.
 *
 * A failed proof deliberately does **not** unregister the task. The task
 * may be correct and the server merely down, and tearing down a good
 * installation because a transient call failed would turn a retryable
 * situation into one needing a fresh install. Reporting `registered: true`
 * alongside the failure is what tells a caller re-running setup is cheap.
 */
export async function runSetup(
  inputs: SetupInputs,
  deps: { readonly register: RegisterFn; readonly verify: VerifyFn },
): Promise<SetupResult> {
  const standupUrl = inputs.standupUrl?.trim();
  const machine = inputs.machine?.trim();
  const sessionId = inputs.sessionId?.trim();

  // Checked before anything is registered, not after. Registering a task
  // and only then discovering there is nothing to verify against would
  // leave a host changed by a run that could never have succeeded.
  if (!standupUrl || !machine || !sessionId) {
    const missing = [
      standupUrl ? undefined : "STANDUP_URL",
      machine ? undefined : "machine",
      sessionId ? undefined : "session",
    ].filter((name): name is string => name !== undefined);
    return {
      ok: false,
      stage: "unconfigured",
      message: `Setup needs ${missing.join(", ")} before it can register anything, because a registration it cannot verify is not worth making. Run \`standup init\` first.`,
    };
  }

  const plan = planScheduledTask(inputs);

  const registered = await deps.register(plan);
  if (!registered.ok) {
    return {
      ok: false,
      stage: "register",
      message: registered.message ?? `Could not register the scheduled task '${plan.taskName}'.`,
    };
  }

  const proof = await deps.verify({ standupUrl, machine, sessionId });
  if (!proof.ok) {
    // The verifier's own message is appended, never substituted for this
    // sentence. What it reports is the transport-level cause ("connection
    // refused"), which is useful and is not the thing the caller most needs
    // to know — that the task *is* registered, that nothing yet proves it
    // fires, and that re-running is safe. Letting a supplied message replace
    // that would make the most important half of the outcome disappear
    // exactly when a lower layer happened to be talkative.
    return {
      ok: false,
      stage: "verify",
      registered: true,
      message:
        `The scheduled task '${plan.taskName}' was registered, but no call reached the server, so nothing proves it works. ` +
        `Re-run setup once the server is reachable; registering again is safe.` +
        (proof.message === undefined ? "" : ` (${proof.message})`),
    };
  }

  return {
    ok: true,
    taskName: plan.taskName,
    intervalMinutes: plan.intervalMinutes,
    verified: true,
    server: {
      ...(proof.hookVariant === undefined ? {} : { hookVariant: proof.hookVariant }),
      ...(proof.protocolVersion === undefined ? {} : { protocolVersion: proof.protocolVersion }),
    },
  };
}
