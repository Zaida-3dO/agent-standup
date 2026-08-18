// The Claude Code plugin's contents, as values (MILESTONES.md #48).
//
// A plugin bundles the three things a session needs — the MCP server, the
// hook wiring and the `standup` command — so that one install leaves a
// machine fully wired rather than three-quarters wired with a step nobody
// wrote down (DECISIONS.md §10). This module is what each of those files
// *says*; `scripts/build-plugin.mjs` is what writes them to disk.
//
// ── Why the contents are values and the writing is a script ─────────────
//
// The reason is the same one `scripts/lib/sweep-schedule.mjs` gives for its
// own split: a file's *contents* are a decision worth asserting directly,
// and a decision buried inside a function that also creates directories can
// only be tested by creating directories. Every field below is reachable as
// a plain object, so a test can assert the MCP URL, the hook matchers and
// the command path without a filesystem, and the one thing left in the
// script is `writeFile`.
//
// ── The package is a dependency, never a copy ───────────────────────────
//
// **This is the substance of the row, not a packaging detail.** The plugin
// declares `agent-standup` as a dependency and resolves the binary through
// the package manager; it does not carry its own copy of `standup.js` or of
// the hook script. A vendored copy is a second version of the same
// artefact, and two versions drift — silently, because nothing compares
// them, and consequentially, because the thing that drifts is what decides
// whether a tool call is allowed. DECISIONS.md §13f states it as the
// distribution rule ("does not vendor a copy — it declares the package as a
// prerequisite and shims to it"), and `tests/plugin-package.test.ts`
// asserts the built directory contains no such copy, which is the half a
// comment cannot prove.
//
// ── Why the hook path is a command line, not a file path ────────────────
//
// A plugin is installed into a directory whose location it does not choose
// and cannot know, so a literal path to the hook script could only ever be
// written by an installer that already knew the answer. Resolving it
// through the package manager's own binary resolution instead means the
// wiring is correct on a machine this repository has never seen — which is
// the only kind of machine a published plugin runs on.

import { SHIPPED_HOOK_PROTOCOL_VERSION } from "@/lib/build-constants";

/** The npm package the plugin consumes. Never vendored — see the header. */
export const PACKAGE_NAME = "agent-standup";

/** The plugin's own name, as a marketplace and `/plugin` listing show it. */
export const PLUGIN_NAME = "agent-standup";

/**
 * The command the hook events are wired to.
 *
 * **`standup hook run`, not the hook script's own path.** The built
 * `standup-hook.js` is deliberately absent from the package's `bin`
 * (`scripts/build-cli.mjs` says why: it is a path a tool executes, not a
 * command a person runs), so it has no name on the PATH to call. `standup
 * hook run` is the published entry point for exactly this — it reads the
 * event from stdin and answers in the agent tool's own JSON shape and exit
 * code — and going through the package's real binary is what keeps the
 * wiring pointed at the installed version rather than at a file path only
 * this repository's layout would produce.
 *
 * `npx --no-install` rather than a bare `npx`: the flag refuses to reach the
 * network. If the package is missing the hook fails immediately and
 * visibly, instead of pausing every tool call in the session on a silent
 * download the first time one fires — and a hook that hangs is worse than a
 * hook that is absent, because the session stalls without saying why.
 */
export const HOOK_COMMAND = `npx --no-install -p ${PACKAGE_NAME} standup hook run`;

/**
 * The events the hook is wired to, and the ones it deliberately is not.
 *
 * `PreToolUse` is where gating lives: by `PostToolUse` the call has already
 * run, so a refusal there refuses something that already happened.
 * `PostToolUse` and `Stop` carry nudges and telemetry and can never block —
 * an invariant the script and the service operation each enforce
 * independently (CLAUDE.md, "The phases are not symmetrical").
 *
 * One script on all three, not three scripts: the script branches on the
 * event type it reads from stdin, which is what keeps a machine's
 * installation a single thing to update.
 */
export const HOOK_EVENTS = Object.freeze(["PreToolUse", "PostToolUse", "Stop"] as const);

/** A single hook entry, in the shape `hooks/hooks.json` takes. */
interface HookEntry {
  readonly matcher: string;
  readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
}

/**
 * The hook configuration the plugin installs.
 *
 * The matcher is `*` — every tool, no exceptions — because the script holds
 * no rules and the decision is the server's. A matcher list here would be a
 * second place rules live, and a local list can only ever express "which
 * command", never "in which situation", which is the whole reason gating is
 * server-side (MILESTONES.md #128).
 */
export function hooksConfig(): Record<string, readonly HookEntry[]> {
  const entry: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  };
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [entry]]));
}

/**
 * The MCP server configuration the plugin installs.
 *
 * `${STANDUP_URL}` is left as an unexpanded placeholder on purpose. Where
 * the server lives is a property of an installation, not of a release, and
 * baking one deployment's address into a published artefact would ship
 * somebody's address to everybody who installs it. Claude Code expands the
 * variable at load time from the environment the session already resolves
 * `STANDUP_URL` from, so the plugin and the command line read the same
 * value from the same place.
 */
export function mcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      [PLUGIN_NAME]: {
        type: "http",
        url: "${STANDUP_URL}/api/mcp",
      },
    },
  };
}

/**
 * The plugin manifest.
 *
 * `version` is the package's version, passed in rather than read here: this
 * module is bundled into a build that has no `package.json` beside it at
 * run time, and a version read at build time from the file the release
 * already stamps is the same number by construction. Row #89 cuts the
 * package and the image on one tag, so there is one version to carry.
 */
export function pluginManifest({ version }: { readonly version: string }): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    version,
    description:
      "Task tracking for coding agents: the MCP server, the tool-call hook, and the standup command line.",
    // The declared dependency *is* the anti-vendoring mechanism, not a note
    // about it. An installer reads this and fetches the package; nothing in
    // the plugin directory has to be a copy of anything in it.
    dependencies: { [PACKAGE_NAME]: version },
    // Recorded so an installation can be compared against a server without
    // running anything: `register_session` answers with the version it
    // wants, and this is what the plugin brought.
    hookProtocolVersion: SHIPPED_HOOK_PROTOCOL_VERSION,
  };
}
