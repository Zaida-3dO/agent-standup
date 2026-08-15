// MILESTONES.md #125 — the hook as an actual process.
//
// Everything else in this row is tested as values in and values out, which
// is what makes the failure paths cheap to cover. This file covers the one
// thing that cannot be: **that the built script, run the way an agent tool
// runs it — a JSON object on stdin, a verdict on stdout and an exit code —
// actually behaves.** The same reasoning `tests/cli-package-publish.test.ts`
// gives for exercising the built binary rather than the source: a
// half-shipped artefact looks fine in TypeScript and only breaks once built.
//
// Three properties are pinned here and nowhere else:
//
//   1. **The exit code reaches the caller.** Every unit test above asserts
//      the *rendered* exit code; only a real process proves the entry point
//      puts it on `process.exitCode` rather than dropping it.
//   2. **A wrongly-invoked hook allows** (DECISIONS.md §16). Nothing on
//      stdin, garbage on stdin, no server configured, a server that refuses
//      the connection — every one exits zero. This is the reversal, proven
//      against the artefact that actually gets installed, because the whole
//      cost of getting it wrong lands here: a fail-closed script wired to
//      `PreToolUse` with an unreachable server kills every tool call in
//      every session on the machine.
//   3. **A real block still refuses.** Asserted against a genuine local
//      HTTP server rather than an injected function, so the transport, the
//      response shape and the exit code are all proven together. Without
//      this the suite would be satisfied by a script that always exits zero.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_ENTRY_POINT } from "../scripts/build-cli.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const builtHook = "dist/bin/standup-hook.js";

let scratch: string;

// `dist/` is built once for the whole run by `tests/helpers/global-setup.ts`,
// which is the only writer — see the note there for why a per-file build races.
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "standup-hook-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the built hook with `stdin`, returning its exit code and both streams. */
function runHookProcess(
  stdin: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [builtHook], {
      cwd: repoRoot,
      input: stdin,
      encoding: "utf8",
      // No STANDUP_URL by default: an inherited one from the developer's
      // shell would make the suite depend on a reachable server.
      //
      // `STANDUP_SPOOL` is pointed into the scratch directory rather than
      // merely cleared, because clearing it would fall back to the spool in
      // the developer's home — so every case that does not set one would
      // append test telemetry to real data. Cases that do set one override
      // this, since `env` is spread last.
      env: {
        ...process.env,
        STANDUP_URL: "",
        STANDUP_SPOOL: path.join(scratch, "default-spool.jsonl"),
        ...env,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/**
 * The same thing, but without blocking this process while it runs.
 *
 * **`execFileSync` cannot be used for any case involving a local server**,
 * and the reason is worth stating because the symptom is baffling: the
 * synchronous variant blocks this process's event loop, so a server started
 * *here* never gets to accept the hook's connection and every such call
 * fails as a five-second timeout — which the hook then reports as an
 * unreachable server, an entirely plausible-looking result that has nothing
 * to do with the code under test.
 */
async function runHookAsync(
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [builtHook],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          STANDUP_URL: "",
          STANDUP_SPOOL: path.join(scratch, "async-spool.jsonl"),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : ((error as { code?: number }).code ?? -1);
        resolve({ status, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

function payload(command: string, eventType = "PreToolUse"): string {
  return JSON.stringify({
    hook_event_name: eventType,
    session_id: "s-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("the built hook artefact", () => {
  it("exists at the built path with a node shebang", () => {
    expect(existsSync(path.join(repoRoot, builtHook))).toBe(true);
    expect(readFileSync(path.join(repoRoot, builtHook), "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
  });

  it("is built from the entry point the build script names", () => {
    expect(HOOK_ENTRY_POINT).toBe("src/bin/standup-hook.ts");
  });

  it("prints its protocol version and exits zero", () => {
    // Printing a version is not a hook verdict and must not read as a
    // refusal — an installer runs this to fill in a registration.
    const stdout = execFileSync(process.execPath, [builtHook, "--protocol-version"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, STANDUP_URL: "" },
    });
    expect(stdout.trim()).toMatch(/^\d+$/);
  });
});

describe("the hook as a process, on the allow path", () => {
  it("exits 0 and says nothing for an ordinary command", () => {
    const result = runHookProcess(payload("git status"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 for a Stop, which carries no command", () => {
    const result = runHookProcess(JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" }));
    expect(result.status).toBe(0);
  });
});

describe("the hook as a process fails OPEN — DECISIONS.md §16", () => {
  // Each of these used to exit 2. They are listed individually rather than
  // as one loop because each is a separate branch in the script, and a
  // change that reinstated fail-closed on any one of them should name which.

  it("exits 0 on empty stdin", () => {
    // The wiring-mistake case. Exiting 2 here would mean a misconfigured
    // installation refuses every tool call — including the Edit that would
    // unwire the hook — for a guard that would have allowed all of them.
    const result = runHookProcess("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when stdin is not JSON at all", () => {
    const result = runHookProcess("garbage");
    expect(result.status).toBe(0);
  });

  it("exits 0 for an event type this build does not know", () => {
    const result = runHookProcess(
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-1" }),
    );
    expect(result.status).toBe(0);
  });

  it("exits 0 with no server configured", () => {
    const result = runHookProcess(payload("rm -rf /"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the server is configured but refuses the connection", () => {
    // Port 9 (discard) is reserved and closed; this is a real connection
    // failure rather than a mocked one.
    const result = runHookProcess(payload("git push"), { STANDUP_URL: "http://127.0.0.1:9" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when STANDUP_URL is not a usable URL", () => {
    const result = runHookProcess(payload("git push"), { STANDUP_URL: "not a url" });
    expect(result.status).toBe(0);
  });
});

describe("the hook as a process, against a real server", () => {
  let server: Server;
  let url: string;
  let reply: (body: Record<string, unknown>) => void;
  let received: unknown[];
  let response: Record<string, unknown> = { decision: "allow" };

  beforeAll(async () => {
    received = [];
    reply = (body) => {
      response = body;
    };
    server = createServer((request, result) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          received.push(null);
        }
        result.writeHead(200, { "content-type": "application/json" });
        result.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exits 2 and prints a reason when the server blocks a pre-tool call", async () => {
    // The assertion the whole suite would otherwise be missing: a script
    // that always exited zero would pass every other test in this file.
    reply({ decision: "block", reason: "there is no approving review at tip" });
    const result = await runHookAsync(payload("git merge main"), { STANDUP_URL: url });

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      decision: string;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.decision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("approving review");
    // Both channels, so a reader of either sees the refusal.
    expect(result.stderr).toContain("approving review");
  });

  it("exits 0 when the server blocks a POST-tool call, because the call already ran", async () => {
    reply({ decision: "block", reason: "there is no approving review at tip" });
    const result = await runHookAsync(payload("git merge main", "PostToolUse"), {
      STANDUP_URL: url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 for a decision value this build does not recognise", async () => {
    reply({ decision: "quarantine", reason: "a future server" });
    const result = await runHookAsync(payload("git merge main"), { STANDUP_URL: url });
    expect(result.status).toBe(0);
  });

  it("exits 0 and surfaces a nudge on stderr without refusing", async () => {
    reply({ decision: "allow", nudge: { budgetBand: "wind-down" } });
    const result = await runHookAsync(payload("git commit", "PostToolUse"), { STANDUP_URL: url });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wind-down");
  });

  it("sends the event's facts to /api/hook", async () => {
    reply({ decision: "allow" });
    received.length = 0;
    await runHookAsync(payload("git status"), { STANDUP_URL: url });

    expect(received.at(-1)).toMatchObject({
      eventType: "PreToolUse",
      sessionId: "s-1",
      tool: "Bash",
      command: "git status",
    });
  });
});

describe("the hook as a process, spooling telemetry", () => {
  // MILESTONES.md #88. Everything about the spool is tested as values
  // elsewhere; what only a real process can prove is that the entry point
  // actually resolves a path, creates the directory and appends to a file —
  // none of which exists in the injected surface.

  function spoolFile(): string {
    return path.join(scratch, `spool-${Math.random().toString(36).slice(2)}.jsonl`);
  }

  it("writes one record per allowed tool call", () => {
    const file = spoolFile();
    const result = runHookProcess(payload("git status"), { STANDUP_SPOOL: file });

    expect(result.status).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ sessionId: "s-1", tool: "Bash", command: "git status" });
    expect(typeof record.ts).toBe("string");
  });

  it("adds to what is already there, across separate invocations", () => {
    // The property the whole format rests on, proven against a real file:
    // the write path is an append, so two processes that never see each
    // other both end up in the spool.
    const file = spoolFile();
    runHookProcess(payload("git status"), { STANDUP_SPOOL: file });
    runHookProcess(payload("git status"), { STANDUP_SPOOL: file });

    expect(readFileSync(file, "utf8").trim().split("\n").length).toBe(2);
  });

  it("creates the spool's parent directory rather than failing", () => {
    // The first run on a fresh machine, where the state directory does not
    // exist yet.
    const file = path.join(scratch, "nested", "deeper", "telemetry.jsonl");
    const result = runHookProcess(payload("git status"), { STANDUP_SPOOL: file });

    expect(result.status).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("still allows when the spool path cannot be written", () => {
    // The property that matters most: telemetry must never be able to turn
    // into a refused tool call. The spool path is an existing *directory*,
    // so every attempt to write it fails at the filesystem level.
    const directory = path.join(scratch, "spool-is-a-directory");
    mkdirSync(directory, { recursive: true });

    const result = runHookProcess(payload("git status"), { STANDUP_SPOOL: directory });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("spools nothing for a payload it could not read", () => {
    // The spool goes in a directory of its own, created fresh here, so the
    // assertion is about this run and nothing else: asserting a *negative*
    // against a shared directory would be satisfiable by another test's
    // leftovers and would fail for reasons that have nothing to do with the
    // hook.
    const directory = mkdtempSync(path.join(tmpdir(), "standup-hook-unreadable-"));
    const file = path.join(directory, "telemetry.jsonl");
    try {
      const result = runHookProcess("garbage", { STANDUP_SPOOL: file });

      expect(result.status).toBe(0);
      expect(existsSync(file)).toBe(false);
      // Stronger than the line above: the hook must not have created the
      // directory either, since it never got as far as having a record.
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
