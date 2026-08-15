// Seeds registered sessions for tests whose subject is not registration.
//
// SCHEMA.md §21 (MILESTONES.md #43) lets an installation refuse a claim from
// a session that has not registered a hook protocol version, behind
// `hook.require_registration_to_claim`. That rule is proved — from both
// sides, in both of the setting's positions — in
// `tests/session-registration.test.ts`. Every *other* DB-backed file that
// claims an item is testing something else (claim/release semantics, board
// filters, MCP tool wiring), and re-deriving the registration in each of them
// would put the same four lines in four places and make each file's setup say
// less about what it is actually for.
//
// **The setting defaults to off, so those claims succeed with or without this
// helper.** It earns its place for a different reason: registering is the
// first thing a real client does, so a file that claims from a registered
// session exercises the shape a running installation presents, and its setup
// stays correct for an installation that chooses the strict posture. Turning
// the setting on across the rest of the suite would be the mistake in the
// other direction — it would make every unrelated file's setup depend on a
// posture the deployment default is not.

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
