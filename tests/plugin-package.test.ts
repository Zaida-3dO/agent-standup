// The plugin package (MILESTONES.md #48) — one install carrying the MCP
// configuration, the hook wiring and the command line.
//
// Two halves, deliberately tested differently. The **contents** are asserted
// against the module that decides them, with no filesystem, because that is
// where the decisions live. The **built directory** is then asserted as a
// real tree on disk, because the failure this row exists to prevent — a
// vendored copy of the binary quietly drifting from the published one — is a
// property of what got written, and cannot be seen by reading the values
// that were supposed to be written.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlugin, PLUGIN_DIR } from "../scripts/build-plugin.mjs";
import {
  HOOK_COMMAND,
  HOOK_EVENTS,
  PACKAGE_NAME,
  PLUGIN_NAME,
  hooksConfig,
  mcpConfig,
  pluginManifest,
} from "@/lib/plugin/manifest";
import { SHIPPED_HOOK_PROTOCOL_VERSION } from "@/lib/build-constants";

describe("what one install carries", () => {
  it("wires the MCP server, the hook and the command line — all three, from one directory", async () => {
    // The row's own sentence: "MCP config, hook config, and the command line
    // in one install." Asserting the three together is what makes this a
    // test of the row rather than three tests of three files, and dropping
    // any one of them from the build fails here.
    const built = await buildTo("one-install");
    const files = await listFiles(built);

    expect(files).toContain(".mcp.json");
    expect(files).toContain("hooks/hooks.json");
    // The command line is carried by declaring the package that contains
    // it, which is the next test's subject.
    const manifest = JSON.parse(
      await readFile(path.join(built, ".claude-plugin/plugin.json"), "utf8"),
    );
    expect(manifest.dependencies).toHaveProperty(PACKAGE_NAME);
  });
});

describe("it consumes the published package rather than carrying a copy", () => {
  // This is the row's substance. A vendored copy is a second version of the
  // artefact that decides whether a tool call is allowed; the two drift with
  // nothing comparing them, and the drift is invisible until something
  // enforces the wrong rules.

  it("declares the package as a dependency at the version being built", () => {
    const manifest = pluginManifest({ version: "9.9.9" });
    expect(manifest.dependencies).toEqual({ [PACKAGE_NAME]: "9.9.9" });
  });

  it("ships exactly the configuration files, and nothing else whatsoever", async () => {
    // The load-bearing assertion, and it is deliberately an **allowlist of
    // the whole output** rather than a denylist of executable extensions.
    // A denylist only catches the copies it thought to name: a review of
    // this row copied the built binary in as `standup.bin` — 85KB of
    // verbatim JavaScript under an extension no list included — and an
    // extension check passed it. Asserting the complete file list instead
    // means any file not named below fails, whatever it is called, which is
    // the only form of this check that cannot be walked around by choosing
    // a different name. Adding a legitimate file to the plugin therefore
    // costs an edit here — a deliberate confirmation step, which is the
    // right price for a directory whose whole contract is "configuration
    // only, never a vendored binary".
    const built = await buildTo("no-copies");
    const files = await listFiles(built);

    expect(files).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
      "skills/setup-agent-standup/SKILL.md",
    ]);
  });

  it("reaches the hook through the installed package's own binary, not a path into this repository", () => {
    const command = HOOK_COMMAND;

    // Names the package, so resolution is the package manager's job.
    expect(command).toContain(PACKAGE_NAME);
    // `standup-hook`, the dedicated entry point — the only one that reads
    // the event from stdin. Wiring `standup hook run` instead resolves and
    // exits zero while enforcing nothing, which the process-level test at
    // the bottom of this file is what actually catches.
    expect(command).toContain("standup-hook");
    // No path into a build tree. `dist/` here would mean the plugin only
    // works on a machine laid out like this repository's checkout.
    expect(command).not.toContain("dist");
    expect(command).not.toMatch(/[/\\]node_modules[/\\]/);
  });

  it("refuses to reach the network to find the package it depends on", () => {
    // `--no-install` is the difference between a missing package failing
    // immediately and every tool call in the session hanging on a silent
    // download. A hook that hangs is worse than one that is absent: the
    // session stalls with nothing saying why.
    expect(HOOK_COMMAND).toContain("--no-install");
  });
});

describe("the hook wiring", () => {
  it("covers the gating phase and both reporting phases", () => {
    const config = hooksConfig();
    // PreToolUse is where a refusal can still refuse something: by
    // PostToolUse the call has run. Losing it silently downgrades every
    // block to a note about something that already happened.
    expect(Object.keys(config).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
    expect(HOOK_EVENTS).toContain("PreToolUse");
  });

  it("wires one script to every tool, holding no matcher list of its own", () => {
    // A matcher list here would be a second place rules live, and a local
    // list can only express "which command", never "in which situation" —
    // which is the whole reason gating is server-side.
    for (const [, entries] of Object.entries(hooksConfig())) {
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      // Narrowed rather than indexed inline: an entry that was absent would
      // otherwise make every assertion below it read as vacuously true.
      expect(entry).toBeDefined();
      expect(entry?.matcher).toBe("*");
      expect(entry?.hooks).toEqual([{ type: "command", command: HOOK_COMMAND }]);
    }
  });

  it("records the protocol version the shipped hook speaks, reading it rather than restating it", () => {
    // So an installation can be compared against a server without running
    // anything. Read from the build constant, so a bump cannot leave the
    // plugin advertising a version nothing implements.
    expect(pluginManifest({ version: "1.0.0" }).hookProtocolVersion).toBe(
      SHIPPED_HOOK_PROTOCOL_VERSION,
    );
  });
});

describe("the MCP configuration", () => {
  it("leaves the server address unexpanded, so no deployment's address ships to everyone", () => {
    const config = mcpConfig() as { mcpServers: Record<string, { url: string; type: string }> };
    const server = config.mcpServers[PLUGIN_NAME];

    // The plugin's MCP entry must exist under the plugin's own name — a
    // server registered under a different key is one no session resolves.
    expect(server).toBeDefined();
    expect(server?.type).toBe("http");
    // A placeholder, resolved from the environment at load time — the same
    // variable the command line already reads, so both halves of an install
    // point at one place.
    expect(server?.url).toBe("${STANDUP_URL}/api/mcp");
    // Guards the guard: an accidentally-expanded value would still contain
    // "/api/mcp", so the absence of a real scheme is what proves nothing
    // concrete was baked in.
    expect(server?.url).not.toMatch(/^https?:/);
  });
});

describe("the built directory", () => {
  it("writes the manifest where the loader looks for it", async () => {
    const built = await buildTo("layout");
    // `.claude-plugin/plugin.json` is the loader's contract. A manifest
    // written to the plugin root instead is a directory that loads as
    // nothing at all, silently.
    await expect(stat(path.join(built, ".claude-plugin/plugin.json"))).resolves.toBeTruthy();
  });

  it("leaves nothing behind from compiling the values it wrote", async () => {
    // The build compiles two TypeScript modules to read their exports. That
    // output is a means, not a shipped file, and leaving it in place would
    // put JavaScript inside the plugin — indistinguishable, to anyone
    // auditing the directory, from a vendored copy of the binary.
    const built = await buildTo("no-leftovers");
    const files = await listFiles(built);

    expect(files.some((f) => f.startsWith(".build"))).toBe(false);
  });
});

// ── helpers ────────────────────────────────────────────────────────────

const scratch = path.resolve(import.meta.dirname, "..", "dist", "plugin-test");

/**
 * Builds the plugin into a directory of this test's own.
 *
 * Never into `PLUGIN_DIR`: `dist/` is built once for the whole run by
 * `tests/helpers/global-setup.ts` so there is a single writer, and building
 * into it here would reopen the delete-then-write window that having one
 * writer closed — a failure that would land in whichever parallel file
 * happened to be reading `dist/` at the time, naming nothing that leads
 * back here.
 */
async function buildTo(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await rm(dir, { recursive: true, force: true });
  await buildPlugin({ version: "0.0.0-test", pluginDir: dir });
  return dir;
}

beforeAll(async () => {
  // A stale tree from an earlier run would let a removed file keep passing
  // an existence check.
  await rm(scratch, { recursive: true, force: true });
});

it("builds into a directory separate from the published one", () => {
  // Guards the helper above: pointed at PLUGIN_DIR, every test here would
  // race the shared build that `tests/helpers/global-setup.ts` owns.
  //
  // Compared as resolved paths rather than by substring: `dist/plugin-test`
  // *contains* `dist/plugin` as text while being a different directory, so a
  // substring check reports a collision that does not exist.
  expect(path.resolve(scratch)).not.toBe(path.resolve(PLUGIN_DIR));
  expect(path.relative(path.resolve(PLUGIN_DIR), path.resolve(scratch)).startsWith("..")).toBe(
    true,
  );
});

/** Every file in the tree, as forward-slashed paths relative to its root. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  };
  await walk(root);
  return out.sort();
}

// ── The wired command, as a process ────────────────────────────────────

/**
 * The hook wiring, proven by running it rather than by matching its text.
 *
 * Everything above asserts what `HOOK_COMMAND` *says*, and a string
 * assertion cannot tell a working entry point from one that parses,
 * resolves, exits zero and enforces nothing. That distinction is not
 * hypothetical: the `standup` binary deliberately supplies no stdin (see
 * `src/bin/standup.ts`), so a hook routed through it reads an empty
 * payload, takes the unreadable-payload branch and **allows** — an
 * installation that reports healthy and gates nothing, which is the one
 * outcome this plugin exists to prevent. A test that matched the command
 * string would have been equally happy with either.
 *
 * So this runs the entry point the plugin actually wires, feeds it a real
 * `PreToolUse` payload, and points it at a server that blocks. The exit
 * code is the assertion: only a script that read stdin, called the server
 * and rendered the verdict can produce a 2.
 */
describe("the wired hook command actually enforces", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((request, result) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        result.writeHead(200, { "content-type": "application/json" });
        result.end(JSON.stringify({ decision: "block", reason: "no approving review at tip" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("names an entry point the package actually publishes", () => {
    // The wiring is a bare command name, so it resolves through the
    // package's `bin`. A name absent from it resolves to nothing on a real
    // install — and `npx --no-install` would then fail rather than fall
    // back, which is the correct failure but only if the name is right.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const invoked = HOOK_COMMAND.split(" ").at(-1);

    expect(Object.keys(pkg.bin)).toContain(invoked);
  });

  it("blocks a pre-tool call when the server says block", async () => {
    // The load-bearing assertion of the whole file. Routed through an entry
    // point that does not read stdin, this exits 0 with empty output.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const entry = pkg.bin[HOOK_COMMAND.split(" ").at(-1) as string] as string;

    const result = await new Promise<{ status: number; stdout: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [entry],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, STANDUP_URL: url } },
        (error, stdout) => {
          const failed = error as { code?: number } | null;
          resolve({ status: failed?.code ?? 0, stdout: stdout ?? "" });
        },
      );
      child.stdin?.end(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s-1",
          tool_name: "Bash",
          tool_input: { command: "git merge main" },
        }),
      );
    });

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).decision).toBe("deny");
  });
});
