// What a built hook script says about *which build it is* — the missing
// half of `src/app/api/hook/script/route.ts`'s own stated failure mode:
// "a session running an old hook while believing it just fetched the
// current one."
//
// ── The failure this exists for ─────────────────────────────────────────
//
// A vendored copy of the hook sat on a machine for eight days carrying a
// build made *before* the capture loop it was supposed to exercise landed
// (`654aeb2`, PR #317). It contained zero occurrences of `capture`. Every
// session ran it, it fired on every tool call, it exited 0 every time, and
// it recorded nothing — because the code that records was not in it. A row
// waited on that evidence and read as healthy the whole time, because
// **a thing that is not happening presents identically to a thing
// happening slowly.**
//
// Nothing about that artifact said which build it was. The only way to find
// out was to grep the bundle for a symbol you already suspected was
// missing — which requires knowing the answer before you can ask the
// question. That is what this module fixes: the artifact states its own
// provenance, so "is this current?" is a comparison rather than an
// investigation.
//
// ── Why the version number was not enough ───────────────────────────────
//
// `./protocol.ts` already makes the hook declare a protocol *version*, and
// that is genuinely load-bearing — but it answers a different question.
// A protocol version says "can we talk to each other"; it is bumped only
// when the wire format changes. The capture loop changed no wire format the
// hook speaks, so the stale artifact and the current one declare the
// **same** protocol version, and every version check between them passed
// correctly while the deployment was eight days behind. A version says what
// this build *speaks*; a stamp says what this build *is*. Only the second
// one can catch a build that is merely old.
//
// ── Why a commit and not a timestamp ────────────────────────────────────
//
// A timestamp answers "how old", which sounds like the question and is not.
// It cannot distinguish a build made an hour ago from the wrong commit from
// a build made a month ago from the right one, and it makes every rebuild
// of identical source produce a different artifact — which would defeat
// comparing two builds by their bytes (the check that proved the deployment
// was current in the first place). A commit identifies the *source*, which
// is the thing a consumer actually needs to compare against.
//
// The stamp is set by `scripts/build-hook-scripts.mjs` via esbuild `define`
// at build time. Under `tsc`, `vitest`, or any other consumer that imports
// this module without going through that build, the substitution has not
// happened and the value is the sentinel below — see `isStamped`.

/**
 * The value a build stamp carries when nothing replaced it.
 *
 * `define` performs a textual substitution at bundle time, so an unbundled
 * consumer — the typechecker, a unit test, `next build` — reads this module
 * as ordinary source and gets this string. That is not an error state: those
 * consumers are reading the repository, where the answer to "which commit is
 * this" is "the one you have checked out". It is only meaningful, and only
 * checked, in a *built artifact*, where an unsubstituted value means the
 * build did not stamp itself and its provenance is unknown.
 */
export const UNSTAMPED = "unstamped" as const;

/**
 * The identifier `scripts/build-hook-scripts.mjs` substitutes at bundle time.
 *
 * Declared, never defined. esbuild's `define` is a *textual* substitution
 * performed before this file is evaluated, so in a built artifact the
 * reference below is gone — replaced by a quoted commit SHA — and nothing
 * ever looks this identifier up at runtime. The declaration exists so that
 * `tsc` and the editor can typecheck the reference; the `typeof` guard is
 * what keeps an unbundled consumer (vitest, `next build`) from throwing a
 * `ReferenceError` on an identifier that genuinely does not exist there.
 */
declare const __STANDUP_HOOK_BUILD_COMMIT__: string | undefined;

/**
 * The commit this build was made from, or {@link UNSTAMPED} outside a build.
 *
 * Declared `string` rather than a narrower type on purpose: after `define`
 * substitutes it this is a commit SHA, and typing it as the literal
 * `"unstamped"` would make every comparison against a real SHA a type error
 * in exactly the code that needs to make one.
 */
export const HOOK_BUILD_COMMIT: string =
  typeof __STANDUP_HOOK_BUILD_COMMIT__ === "string" ? __STANDUP_HOOK_BUILD_COMMIT__ : UNSTAMPED;

/** Whether a stamp names a build rather than admitting it has no idea. */
export function isStamped(commit: string): boolean {
  return commit !== UNSTAMPED && commit.trim() !== "";
}

/** What a built script prints for `--build-commit`, and what a checker parses back. */
export function formatBuildStamp(commit: string): string {
  return isStamped(commit) ? commit : UNSTAMPED;
}
