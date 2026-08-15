// Resolves a hook variant to the bytes of its built, servable script —
// MILESTONES.md #125(b): `GET /hook/script?variant=<variant>`
// (`src/app/api/hook/script/route.ts`).
//
// ── Why this sits at `src/lib/`, not under `src/lib/hook/` ───────────────
//
// `tests/hook-script-boundaries.test.ts` holds every module under
// `src/lib/hook/` to a hard rule: no `node:fs`, no bare `process`, no
// ambient `fetch` — because that is what makes the hook's *decision logic*
// (`decide.ts`, `run.ts`, …) testable as values in and values out, with no
// filesystem or socket in the loop. This module reads a file off disk on
// purpose — that is its entire job — so it is server-side plumbing that
// happens to be *about* hook scripts, not a part of the hook itself, and
// putting it in the directory that rule scans would either fail the check
// or force a carve-out that weakens what the check is for. `sessions.ts`
// and `session-transport-header.ts` are the existing precedent for this
// split: hook-adjacent logic that is not the hook lives as a flat module at
// `src/lib/`, not nested under `hook/`.
//
// ── Why this reads from disk rather than importing the built module ─────
//
// The build this reads (`scripts/build-hook-scripts.mjs`) exists precisely
// because a hook script has to be handed to a caller as **one self-contained
// file it can write to disk**, not executed in this process — a caller
// fetching its own hook is not asking this server to run it on their behalf.
// So the route serves bytes, and this module's only job is finding the right
// file: it never imports, parses or executes what it reads.
//
// ── Why a variant can be "known" but still absent ────────────────────────
//
// `HookVariant` (`build-constants.ts`) names two slots — `cli` and `http` —
// because SCHEMA.md §21's `hook_variant` column and the whole registration
// handshake are built around both existing. Only `http` has a script built
// (`HOOK_SCRIPT_ENTRY_POINTS` in `scripts/build-hook-scripts.mjs`). Those
// are two different failures for a caller: asking for `carrier-pigeon` is
// asking for something this build will never have an opinion about; asking
// for `cli` is asking for a real, named thing that has no script built for
// it. Both answer with "nothing to send" (`undefined`), because from a
// caller's perspective the outcome is identical — there is no file to
// fetch — but they are kept as separate checks below (schema membership,
// then file existence) so that adding a `cli` script later is exactly one
// entry in the build map and requires no change here.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isHookVariant, type HookVariant } from "@/lib/build-constants";

/** Where `buildHookScripts` (`scripts/build-hook-scripts.mjs`) writes each variant's file, relative to the repo root. */
const HOOK_SCRIPTS_DIR = "dist/hook-scripts";

/** The built script's bytes for one variant, or `undefined` when there is none to serve. */
export interface HookScript {
  readonly variant: HookVariant;
  readonly contents: Buffer;
}

export interface ResolveHookScriptInput {
  /** The value a caller supplied, unvalidated — a query parameter is always a string or absent. */
  readonly variant: unknown;
  /** The repository root the build wrote under. Defaults to the running process's cwd (the Dockerfile's `WORKDIR`, and every local invocation's checkout root). Overridable so a test can point at a scratch tree instead of the real `dist/`. */
  readonly repoRoot?: string;
}

/**
 * Reads a variant's built script off disk.
 *
 * Returns `undefined` — never throws — for anything that isn't a real,
 * built script: a value that isn't one of `HOOK_VARIANTS` at all, and a
 * variant that is one of them but has no file built for it yet. The route
 * turns either into the same `404`; this function's job is only to say
 * whether there is something to send.
 */
export function resolveHookScript({
  variant,
  repoRoot = process.cwd(),
}: ResolveHookScriptInput): HookScript | undefined {
  if (!isHookVariant(variant)) return undefined;

  const scriptPath = path.join(repoRoot, HOOK_SCRIPTS_DIR, `${variant}.js`);
  if (!existsSync(scriptPath)) return undefined;

  // `existsSync` is true for a directory too — a directory happening to sit
  // where the built script should be (a broken or partial build) would
  // otherwise throw `EISDIR` out of `readFileSync` and surface as a bare 500
  // from the route, breaking the documented "never throws" contract above.
  // Caught narrowly by error code, not by wrapping the read in a bare
  // `catch {}`: a blanket catch would also swallow ENOENT from a file
  // deleted in the gap between the `existsSync` check above and this read
  // (a real, if rare, race) and any other unexpected read failure — turning
  // every one of them into the same silent "nothing to send" as a merely
  // unbuilt variant, and hiding a mutation to the `existsSync` guard itself
  // behind this catch instead of failing loudly.
  try {
    return { variant, contents: readFileSync(scriptPath) };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EISDIR") return undefined;
    throw err;
  }
}
