// Seeds registered sessions for tests whose subject is not registration.
//
// SCHEMA.md §21 (MILESTONES.md #43) refuses a claim from a session that has
// not registered a hook protocol version. That rule is proved — from both
// sides, including every refusal — in `tests/session-registration.test.ts`.
// Every *other* DB-backed file that claims an item is testing something else
// (claim/release semantics, board filters, MCP tool wiring), and re-deriving
// the registration in each of them would put the same four lines in four
// places and make each file's setup say less about what it is actually for.
//
// **A helper rather than turning the rule off in those tests.** A setting
// exists that would disable the check, and reaching for it here would mean
// the rest of the suite ran against a configuration the deployment default
// is not — so a regression that only appears when the rule is on would be
// invisible everywhere except the one file that tests the rule. Seeding a
// registration is what a real session does, so the other files exercise the
// same path a running installation does.

import type { PrismaClient } from "@prisma/client";
import { HOOK_PROTOCOL } from "@/lib/build-constants";

/**
 * Registers each session id as current, over `http`.
 *
 * `current` rather than `minSupported`: these sessions are incidental to
 * whatever their file is testing, and a session sitting on the advisory
 * boundary would make an unrelated failure look like a version problem.
 */
export async function registerSessions(
  prisma: PrismaClient,
  sessionIds: readonly string[],
  machine = "test-machine",
): Promise<void> {
  for (const id of sessionIds) {
    await prisma.session.upsert({
      where: { id },
      create: {
        id,
        machine,
        transport: "http",
        hookVariant: "http",
        hookVersion: HOOK_PROTOCOL.http.current,
      },
      update: { hookVersion: HOOK_PROTOCOL.http.current },
    });
  }
}
