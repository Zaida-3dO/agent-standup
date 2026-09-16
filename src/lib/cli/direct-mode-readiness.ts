// Recognising the one installation failure that direct mode dies of, and
// saying something actionable about it.
//
// **The defect this exists to name.** `package.json`'s `files` list decides
// what reaches an installed package, and it was `["dist"]`, so `prisma/` —
// the schema and its migration history — never shipped. That matters more
// than it sounds: `generator client { provider = "prisma-client-js" }`
// produces a client not at build time but at *install* time, by reading the
// schema. With no schema anywhere, `@prisma/client` stays the placeholder
// module whose only job is to throw, and every direct-mode command on a
// published install died with
//
//     @prisma/client did not initialize yet.
//     Please run "prisma generate" and try to import it again.
//
// a true sentence and useless advice, because `prisma generate` reads a
// schema and there was none to read. The one instruction the error gave was
// the one thing that could not work. It arrived as an unhandled crash with
// a stack trace into a hashed bundle chunk, not as a refusal.
//
// **Two changes were needed, and the second is the one that is easy to
// miss.** Its sibling change ships `prisma/`, which is what lets `standup
// init` find a schema and the migration-drift check find a history. But
// shipping the schema does NOT by itself make direct mode work: npm
// generates nothing for an installed *dependency*, and this package has no
// `postinstall` hook, so the client is still the placeholder and the crash
// is byte-identical. Verified by installing a real tarball into an empty
// directory both before and after adding `prisma/` — the first fix alone
// changed nothing about this error, which is exactly the trap of testing a
// packaging change from a git checkout, where a generated client is simply
// lying around.
//
// So this module does not try to predict the failure; `run.ts` lets the
// load fail and asks here whether *that* is what happened. Deliberately
// imports nothing from Prisma: it is reachable from the entry chunk, and a
// `@prisma/client` specifier there would undo the code splitting that keeps
// `standup --help` from loading a database client at all.

/**
 * Is this the placeholder `@prisma/client` refusing to initialise?
 *
 * Matched on the message text, which is load-bearing enough to justify
 * saying why: the placeholder throws a plain `Error`, with no code, no
 * class and no property distinguishing it from any other failure, so the
 * message is the only thing there is to key on. Both halves of the
 * sentence are accepted independently because the wording has shifted
 * across Prisma versions while always containing one or the other.
 *
 * `cause` is unwrapped as well as the error itself — the throw happens
 * inside a dynamically imported module, and a loader that wraps it would
 * otherwise hide the match and return the crash this exists to replace.
 */
export function isUngeneratedPrismaClient(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && MARKERS.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const MARKERS = /did not initialize yet|Please run ["`']?prisma generate/i;

/**
 * What to tell someone whose install cannot do direct mode.
 *
 * Names what is actually wrong, why the obvious fix does not work *as
 * written*, and the two things that do. The middle clause earns its length:
 * without it the reader has this message and Prisma's contradicting one and
 * no way to choose. The explicit `--schema` invocation is given because,
 * now that `prisma/` ships, it genuinely works — which it could not before.
 */
export const DIRECT_MODE_UNAVAILABLE_MESSAGE =
  "The Prisma client for this installation has not been generated, so direct database mode " +
  'cannot run. A bare "prisma generate" will not fix it: npm does not generate a client for ' +
  "an installed dependency, and this package ships no postinstall hook. " +
  "Either set STANDUP_URL to talk to a standup server over HTTP — the supported path for an " +
  "npm/npx install, and the one every shipped npx command already uses — or, to use direct " +
  "mode, point Prisma at this package's bundled schema explicitly: " +
  "`npx prisma generate --schema <path-to>/node_modules/agent-standup/prisma/schema.prisma`.";
