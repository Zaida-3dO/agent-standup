// The `/setup-agent-standup` skill's text (MILESTONES.md #49).
//
// A value rather than a file checked into `plugin/skills/`, for the same
// reason `manifest.ts` states about the configuration files it owns: the
// text names the task, the interval and the command line, and every one of
// those is already a constant in `setup.ts`. Written out as prose in a
// separate file, each would be a second copy free to drift from the code
// that actually registers the task — and a skill that describes a different
// interval from the one it registers is worse than one that describes
// nothing, because it is read as authoritative.
//
// So the skill is generated from the same constants the command uses. The
// numbers in the installed skill are the numbers that run, by construction.

import {
  DEFAULT_INTERVAL_MINUTES,
  LOGON_TYPE,
  RUN_LEVEL,
  TASK_NAME,
  TASK_VERB,
  planScheduledTask,
} from "./setup";

export const SKILL_NAME = "setup-agent-standup";

/**
 * The skill's front matter and body.
 *
 * The body is written as instructions to an agent rather than to a person,
 * because that is what runs it, and it leads with the verification because
 * that is the step the row exists for. An installation that registers a
 * task and stops has not been set up — it has been left in the state where
 * it reports success and polls nothing, which is indistinguishable from
 * working right up until the moment it matters.
 */
export function skillDocument(): string {
  const plan = planScheduledTask();
  const commandLine = [plan.execute, ...plan.arguments].join(" ");

  return `---
name: ${SKILL_NAME}
description: Register this machine's Agent Standup poller and prove it works. Run it after installing the plugin, and re-run it any time to health-check the installation.
---

# Set up Agent Standup on this machine

The plugin carries the MCP server, the hook and the command line. One thing it
cannot carry is the operating system's scheduler entry, because no plugin can
write one. This skill adds it — and then proves it.

## Registering is not the finish line

Verify, do not just install. A scheduled task can register successfully and
never fire: a principal that cannot attach to the logon session, a command that
does not resolve on this machine, an execution policy that refuses it. Every one
of those leaves a registered task, a success message, and a machine that polls
nothing. That is the state this skill exists to make impossible, so **do not
report success until a call has reached the server and the server has answered.**

## Steps

1. **Check the configuration.** \`STANDUP_URL\` must resolve, and this session
   needs an id and a machine name. Without them there is nothing to verify
   against, so nothing should be registered — a host changed by a run that could
   never have succeeded is worse than a run that stopped early.

2. **Register the task** \`${TASK_NAME}\`, running \`${commandLine}\` every
   ${DEFAULT_INTERVAL_MINUTES} minutes, with logon type \`${LOGON_TYPE}\` and run
   level \`${RUN_LEVEL}\`. That principal attaches to the existing logon session,
   so it keeps firing while the machine is locked, and it needs no elevation and
   stores no credential. The variant that survives a full logoff runs without a
   desktop and is a different tool, not a safer one.

3. **Prove it.** Register this session with the server and read the reply. A
   reply naming a hook variant and a protocol version is the proof; anything
   else is not.

4. **Report what happened**, in these terms: the task name, the interval, and
   whether a call reached the server. If registration succeeded and the proof did
   not, say exactly that and leave the task in place — it may be correct and the
   server merely unreachable, and re-running this skill is safe.

## Re-running it is the health check

Registration is idempotent and the proof is a live call, so running this a
second time answers "is this machine still wired up" without changing anything
that was already right.

## Removing it

Unregister the task named \`${TASK_NAME}\`. Nothing else on the machine is
changed by this skill; the plugin itself is removed the way it was installed.
`;
}

export { TASK_NAME, TASK_VERB };
