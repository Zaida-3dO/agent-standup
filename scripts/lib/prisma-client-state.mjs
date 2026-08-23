#!/usr/bin/env node
// Is the generated Prisma client actually present?
//
// **The trap this exists to name.** `npm ci` does not generate the client:
// there is no `postinstall` script, and `@prisma/client` ships a placeholder
// module whose job is to throw a helpful error until `prisma generate` has
// replaced it. In a plain long-lived checkout that generation happened once,
// long ago, and nobody thinks about it again — but every crew here works in a
// fresh `git worktree`, which gets its own empty `node_modules`, so it is the
// normal path rather than an edge case.
//
// **Why it is worth its own check rather than letting the error speak.** The
// placeholder's message is good, but it arrives as six unrelated-looking
// failures across the suite, and only some of them show it. The rest surface
// as assertions about something else entirely — `tests/boot.test.ts` reports
//
//     expected Error: @prisma/client did not initialize … to be an instance
//     of DatabaseUnreachableError
//
// which reads as a defect in the boot code's error handling, not as a missing
// build step. Every crew that hit this spent time diagnosing the wrong thing.
//
// So the run stops once, at the top, with the one sentence that fixes it.
import { createRequire } from "node:module";

/** The command that fixes every state this module reports as not ready. */
export const FIX_COMMAND = "npx prisma generate";

/**
 * Why the client is unusable, or `null` when it is fine.
 *
 * Three states rather than a boolean, because "no `@prisma/client` package at
 * all" means `npm ci` was never run and is different advice from "the package
 * is there but ungenerated".
 *
 * @param {(id: string) => unknown} [load] how to import the client package
 * @returns {"missing-package" | "ungenerated" | null}
 */
export function prismaClientProblem(load = defaultLoad) {
  let mod;
  try {
    mod = load("@prisma/client");
  } catch (error) {
    // The placeholder throws on *import* with this text. Distinguishing it
    // from a genuinely absent package matters: they have different fixes.
    if (/did not initialize yet|Please run ["`']?prisma generate/i.test(String(error?.message))) {
      return "ungenerated";
    }
    return "missing-package";
  }

  // Present and importable, but a stub: the real generated client exports a
  // `PrismaClient` constructor. Checked rather than assumed, because the
  // placeholder is a real module that imports cleanly in some versions and
  // only fails when constructed.
  const PrismaClient = /** @type {{ PrismaClient?: unknown }} */ (mod)?.PrismaClient;
  return typeof PrismaClient === "function" ? null : "ungenerated";
}

function defaultLoad(id) {
  return createRequire(import.meta.url)(id);
}

/** What to tell the developer, for each way the client can be unusable. */
export function adviceFor(problem) {
  if (problem === "missing-package") {
    return (
      "The `@prisma/client` package is not installed.\n\n" +
      "  Run `npm ci`, then `" +
      FIX_COMMAND +
      "`."
    );
  }
  return (
    "The Prisma client has not been generated in this working tree.\n\n" +
    "  Run:  " +
    FIX_COMMAND +
    "\n\n" +
    "  `npm ci` does not do this for you — there is no postinstall hook — and a\n" +
    "  fresh `git worktree` gets its own empty node_modules, so this is the normal\n" +
    "  state of a new worktree rather than a broken one.\n\n" +
    "  Without it several suites fail in ways that look like defects in the code\n" +
    "  under test rather than a missing build step, which is why the run stops here."
  );
}

/**
 * Throws with actionable advice when the client is unusable.
 *
 * @param {(id: string) => unknown} [load]
 */
export function assertPrismaClientReady(load = defaultLoad) {
  const problem = prismaClientProblem(load);
  if (problem) throw new Error(adviceFor(problem));
}
