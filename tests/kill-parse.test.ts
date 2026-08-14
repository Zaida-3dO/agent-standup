// Reading a kill command — MILESTONES.md #45, `src/lib/kill/parse.ts`.
//
// **What would make this file hollow, stated first.** A suite that only
// asserted `taskkill /IM node.exe` parses as an executable target would pass
// against a parser that returned an executable target for *everything*, and
// the guard downstream would then refuse or allow uniformly regardless of
// the command. So the assertions below are organised around the three
// outcomes being **told apart**: every case names which outcome it expects
// and at least one case for each pair of outcomes uses commands that differ
// by a single token.
//
// The distinction that carries the most weight is `unparseable` vs
// `not-a-kill`, because collapsing them is the one mistake here that
// silently disables the guard — `unparseable` denies, `not-a-kill` is
// waved through to ordinary classification.
import { describe, expect, it } from "vitest";
import { normaliseExecutable, parseKillCommand, splitStatements, tokenise } from "@/lib/kill/parse";

describe("commands that end no process", () => {
  it.each([
    "ls -la",
    "git status",
    "npm run build",
    // Contains the word but is not the verb — a substring match would call
    // this a kill and refuse a perfectly ordinary command.
    "npm run kill-switch-test",
    "echo killall",
    // A path whose last segment is not a kill verb.
    "/usr/bin/killer 123",
  ])("%s is not a kill", (command) => {
    expect(parseKillCommand(command)).toEqual({ kind: "not-a-kill" });
  });

  it("an empty command is not a kill", () => {
    expect(parseKillCommand("")).toEqual({ kind: "not-a-kill" });
  });
});

describe("process ids, read positionally and behind flags", () => {
  it("kill 4821 targets one pid", () => {
    expect(parseKillCommand("kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("a signal flag is not mistaken for a target", () => {
    expect(parseKillCommand("kill -9 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("kill -SIGKILL 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("kill -s TERM 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("several pids are all targets, not just the first", () => {
    expect(parseKillCommand("kill 1 2 3")).toEqual({
      kind: "targets",
      targets: [
        { kind: "pid", value: "1" },
        { kind: "pid", value: "2" },
        { kind: "pid", value: "3" },
      ],
    });
  });

  it("taskkill reads a pid behind /PID", () => {
    expect(parseKillCommand("taskkill /F /PID 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("Stop-Process reads a pid behind -Id", () => {
    expect(parseKillCommand("Stop-Process -Id 4821 -Force")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("sudo and an environment assignment do not hide the verb", () => {
    expect(parseKillCommand("sudo kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("FOO=bar kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });
});

describe("executables — the machine-wide shape the guard exists for", () => {
  it("taskkill /IM names an executable, normalised", () => {
    expect(parseKillCommand("taskkill /F /IM node.exe")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("case and the .exe suffix do not create two different targets", () => {
    const upper = parseKillCommand("taskkill /IM NODE.EXE");
    const lower = parseKillCommand("taskkill /IM node");
    expect(upper).toEqual(lower);
  });

  it("killall and pkill name an executable", () => {
    expect(parseKillCommand("killall node")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
    expect(parseKillCommand("pkill node")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("Stop-Process -Name names an executable", () => {
    expect(parseKillCommand("Stop-Process -Name node -Force")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });
});

describe("a kill it cannot read is unparseable, never not-a-kill", () => {
  // This block is the point of the file. Every case here is a real command
  // that ends processes and whose target set this build does not model; each
  // must be `unparseable` so the guard denies. If any of them regressed to
  // `not-a-kill`, the guard would wave it through, and no assertion about a
  // happy-path parse would notice.
  it.each([
    // A filter, not a name — the quoted argument is one token and the flag
    // is unrecognised.
    ['taskkill /F /FI "IMAGENAME eq node.exe"', "taskkill filter"],
    // Matches whole command lines, which is wider than an image name.
    ["pkill -f agent-standup", "pkill -f"],
    // Selects by user; kills everything that user owns.
    ["pkill -u builder", "pkill -u"],
    // Selects by parent.
    ["pkill -P 100", "pkill -P"],
    // A job spec, not a pid.
    ["kill %1", "job spec"],
    // A negative pid is a process GROUP on POSIX — wider than one process.
    ["kill -- -4821", "process group"],
    // Named nothing at all.
    ["taskkill /F", "taskkill with no target"],
    ["kill", "bare kill"],
    ["taskkill /PID", "a flag with no value"],
    ["taskkill /IM", "a name flag with no value"],
  ])("%s is unparseable (%s)", (command) => {
    const parsed = parseKillCommand(command);
    expect(parsed.kind).toBe("unparseable");
    // The reason is required to be a real sentence, not an empty string: it
    // is what the refused agent reads, and an empty one leaves it retrying.
    if (parsed.kind === "unparseable") expect(parsed.reason.length).toBeGreaterThan(10);
  });

  it("a single unreadable statement makes the whole command unparseable", () => {
    // A parser that returned the readable targets and dropped the rest would
    // hand the guard a set that omits the dangerous half — and the guard
    // would then allow a command it had only half seen.
    const parsed = parseKillCommand("kill 4821 && pkill -f node");
    expect(parsed.kind).toBe("unparseable");
  });
});

describe("statements — the verb is not always the first word", () => {
  it("a kill after && is still a kill", () => {
    expect(parseKillCommand("ls && taskkill /IM node.exe")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it.each([";", "&&", "||", "|", "\n", "&"])("%s separates statements", (separator) => {
    const parsed = parseKillCommand(`echo hello${separator}kill 4821`);
    expect(parsed).toEqual({ kind: "targets", targets: [{ kind: "pid", value: "4821" }] });
  });

  it("kills in several statements are all collected", () => {
    expect(parseKillCommand("kill 1 ; kill 2")).toEqual({
      kind: "targets",
      targets: [
        { kind: "pid", value: "1" },
        { kind: "pid", value: "2" },
      ],
    });
  });

  it("a separator inside quotes does not invent a statement", () => {
    // Without quote-awareness this reads as a second statement beginning
    // `kill 1` and reports a kill for a command that runs none.
    expect(parseKillCommand('echo "a && kill 1"')).toEqual({ kind: "not-a-kill" });
  });
});

describe("tokenise", () => {
  it("keeps a quoted argument as one token", () => {
    expect(tokenise('taskkill /FI "IMAGENAME eq node.exe"')).toEqual([
      "taskkill",
      "/FI",
      "IMAGENAME eq node.exe",
    ]);
  });

  it("collapses runs of whitespace rather than emitting empty tokens", () => {
    expect(tokenise("kill   \t 4821")).toEqual(["kill", "4821"]);
  });
});

describe("splitStatements", () => {
  it("drops empty statements rather than yielding blanks", () => {
    expect(splitStatements("kill 1 ;; kill 2")).toHaveLength(2);
  });
});

describe("normaliseExecutable", () => {
  it("lower-cases and drops one .exe suffix", () => {
    expect(normaliseExecutable("Node.EXE")).toBe("node");
    expect(normaliseExecutable("node")).toBe("node");
  });

  it("leaves an interior .exe alone", () => {
    // `node.exe.bak` is a different file from `node.exe`, and conflating
    // them would let a registration for one answer for the other.
    expect(normaliseExecutable("node.exe.bak")).toBe("node.exe.bak");
  });
});
