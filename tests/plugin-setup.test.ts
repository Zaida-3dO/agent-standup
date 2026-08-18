// `/setup-agent-standup` (MILESTONES.md #49) — registers the scheduled task,
// then proves it works with a live call.
//
// **Nothing in this file registers a scheduled task, and that is a
// requirement rather than a convenience.** CLAUDE.md: anything touching a
// scheduled task or an installer touches the host, and must be provable
// without changing it. `runSetup` takes both effects as injected functions,
// so every case below drives the real decision path with stubs, and the
// machine ends the run with nothing registered on it. A test that actually
// registered one would also be a test that could only run on one operating
// system.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERVAL_MINUTES,
  LOGON_TYPE,
  RUN_LEVEL,
  TASK_NAME,
  TASK_VERB,
  planScheduledTask,
  runSetup,
  type SetupInputs,
} from "@/lib/plugin/setup";
import { PACKAGE_NAME } from "@/lib/plugin/manifest";
import { skillDocument } from "@/lib/plugin/skill";

const configured: SetupInputs = {
  standupUrl: "http://server.invalid",
  machine: "desktop",
  sessionId: "session-a",
};

function stubs(
  overrides: {
    register?: () => Promise<{ ok: boolean; message?: string }>;
    verify?: () => Promise<{
      ok: boolean;
      message?: string;
      hookVariant?: string;
      protocolVersion?: number;
    }>;
  } = {},
) {
  return {
    register: vi.fn(overrides.register ?? (async () => ({ ok: true }))),
    verify: vi.fn(
      overrides.verify ?? (async () => ({ ok: true, hookVariant: "http", protocolVersion: 1 })),
    ),
  };
}

describe("the proof is the point", () => {
  it("reports success only after a call reached the server", async () => {
    const deps = stubs();
    const result = await runSetup(configured, deps);

    expect(result.ok).toBe(true);
    expect(deps.verify).toHaveBeenCalledOnce();
    if (result.ok) {
      expect(result.verified).toBe(true);
      expect(result.server).toEqual({ hookVariant: "http", protocolVersion: 1 });
    }
  });

  it("does NOT report success when the task registered but nothing reached the server", async () => {
    // The failure this row exists to prevent, stated directly: a scheduled
    // task can register cleanly and never fire — wrong principal, a command
    // that does not resolve, an execution policy that refuses it — and every
    // one of those produces a registered task and a machine that polls
    // nothing. A setup step that stopped at "registered" would return
    // success here, leaving an installation believing it is protected when
    // it is not.
    const deps = stubs({ verify: async () => ({ ok: false, message: "connection refused" }) });
    const result = await runSetup(configured, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      // Registration did happen, and saying so is what tells a caller that
      // re-running is cheap rather than a fresh install.
      expect(result.registered).toBe(true);
      expect(result.message).toContain("registered");
    }
  });

  it("verifies after registering, never before", async () => {
    // Order is load-bearing. Verifying first would prove only that a server
    // is reachable — already true before setup ran — and would say nothing
    // about the task that was just installed. Verifying after is what ties
    // the answer to the installation.
    const calls: string[] = [];
    const result = await runSetup(configured, {
      register: async () => {
        calls.push("register");
        return { ok: true };
      },
      verify: async () => {
        calls.push("verify");
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["register", "verify"]);
  });
});

describe("it refuses to touch the host when it could not possibly verify", () => {
  it.each([
    ["no server address", { ...configured, standupUrl: undefined }, "STANDUP_URL"],
    ["no machine", { ...configured, machine: undefined }, "machine"],
    ["no session", { ...configured, sessionId: undefined }, "session"],
    [
      "a blank server address, as an unset variable yields",
      { ...configured, standupUrl: "  " },
      "STANDUP_URL",
    ],
  ])("registers nothing when there is %s", async (_label, inputs, named) => {
    // Checked before anything is registered, not after: registering a task
    // and only then discovering there is nothing to verify against would
    // leave a host changed by a run that could never have succeeded.
    const deps = stubs();
    const result = await runSetup(inputs as SetupInputs, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("unconfigured");
      expect(result.message).toContain(named);
    }
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("does not try to verify a registration that failed", async () => {
    const deps = stubs({ register: async () => ({ ok: false, message: "access denied" }) });
    const result = await runSetup(configured, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("register");
    // Verifying anyway could return a success — a *different* installation
    // on the same machine answering — and report a task that was never
    // registered as working.
    expect(deps.verify).not.toHaveBeenCalled();
  });
});

describe("what would be registered", () => {
  it("attaches to the existing logon session with no elevation and no stored credential", () => {
    const plan = planScheduledTask();

    // The spike's conclusion (docs/spikes/unattended-windows-launch/): this
    // principal keeps firing while the machine is locked. The variant that
    // survives a full logoff runs in a session with no desktop — a
    // different tool, not a safer one.
    expect(plan.logonType).toBe(LOGON_TYPE);
    expect(plan.logonType).toBe("Interactive");
    expect(plan.runLevel).toBe(RUN_LEVEL);
    expect(plan.runLevel).toBe("Limited");
  });

  it("runs the installed package's own command, not a path into a build tree", () => {
    const plan = planScheduledTask();
    const line = [plan.execute, ...plan.arguments].join(" ");

    expect(line).toContain(PACKAGE_NAME);
    expect(line).toContain(TASK_VERB);
    // A path here would make the task work only on a machine laid out like
    // this repository's checkout.
    expect(line).not.toContain("dist");
    expect(line).not.toMatch(/[/\\]node_modules[/\\]/);
  });

  it("can be read without registering anything", () => {
    // The plan is separate from the registration so "what is about to happen
    // on this host" is answerable without doing it.
    const plan = planScheduledTask({ taskName: "Custom", intervalMinutes: 11 });
    expect(plan.taskName).toBe("Custom");
    expect(plan.intervalMinutes).toBe(11);
  });

  it("defaults to the documented task name and interval", () => {
    const plan = planScheduledTask();
    expect(plan.taskName).toBe(TASK_NAME);
    expect(plan.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  it("passes the caller's plan to the registration untouched", async () => {
    const deps = stubs();
    await runSetup({ ...configured, taskName: "Other", intervalMinutes: 3 }, deps);

    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "Other", intervalMinutes: 3, logonType: LOGON_TYPE }),
    );
  });
});

describe("the skill the plugin installs", () => {
  it("states the numbers it actually registers, rather than a second copy of them", () => {
    // Generated from the same constants the command uses, so the skill and
    // the code cannot describe different intervals. A skill that documents
    // an interval nothing registers is worse than one documenting nothing,
    // because it is read as authoritative.
    const doc = skillDocument();

    expect(doc).toContain(TASK_NAME);
    expect(doc).toContain(String(DEFAULT_INTERVAL_MINUTES));
    expect(doc).toContain(LOGON_TYPE);
    expect(doc).toContain(RUN_LEVEL);
    expect(doc).toContain(TASK_VERB);
  });

  it("tells the agent not to report success on registration alone", () => {
    // The instruction that carries the row. Losing it leaves a skill that
    // installs and declares victory.
    //
    // Matched against the text with its line breaks and emphasis markers
    // collapsed, because both are typography: the sentence is wrapped for
    // width and bolded for prominence, and a literal match would break the
    // day someone re-wraps a paragraph without changing a word of it.
    const doc = skillDocument().replace(/\*/g, "").replace(/\s+/g, " ");

    expect(doc.toLowerCase()).toContain("verify, do not just install");
    expect(doc).toMatch(/do not report success until a call has reached the server/i);
  });

  it("carries front matter naming the skill", () => {
    const doc = skillDocument();
    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toContain("name: setup-agent-standup");
  });
});
