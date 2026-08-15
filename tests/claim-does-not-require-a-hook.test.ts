// Ownership does not depend on running the hook.
//
// **The refusal is the interesting half, and it is the half that has to stay
// reachable.** `assertSessionMayClaim` is a gate with two positions, and a
// test that only proves the open one would pass just as happily against a
// function that had been deleted. So both are asserted here: off, an
// unregistered session claims; on, the same session is refused, with the
// error shape a caller actually reads.
//
// The default is asserted separately from the behaviour on purpose. The
// behaviour is a property of the function; the default is a product decision
// that can be changed by editing one line in the registry, and a decision
// nothing asserts is a decision that can be reverted by accident.

import { describe, expect, it } from "vitest";
import { SETTINGS_REGISTRY } from "@/lib/settings/registry";
import { assertSessionMayClaim } from "@/lib/service/session-registration";
import { ForbiddenError } from "@/lib/service/errors";

const KEY = "hook.require_registration_to_claim";

/**
 * A context with no `Session` row for the id — the honest shape for a
 * session that never registered, which is the case that used to make
 * ownership unreachable.
 */
function ctxWith(required: boolean, rows: unknown[] = []) {
  return {
    settings: { values: { [KEY]: required } },
    db: { $queryRawUnsafe: async () => rows },
  } as unknown as Parameters<typeof assertSessionMayClaim>[0];
}

describe("the claim gate's default", () => {
  it("ships off, so a session that runs no hook can still own work", () => {
    expect(SETTINGS_REGISTRY[KEY].default).toBe(false);
  });

  it("is still declared, so an installation can choose the strict posture", () => {
    expect(SETTINGS_REGISTRY[KEY].schema.safeParse(true).success).toBe(true);
    expect(SETTINGS_REGISTRY[KEY].sensitive).toBe(true);
  });
});

describe("assertSessionMayClaim", () => {
  it("permits an unregistered session when the setting is off", async () => {
    await expect(assertSessionMayClaim(ctxWith(false), "session-a")).resolves.toBeUndefined();
  });

  it("permits an unregistered session when the setting is absent entirely", async () => {
    const ctx = { settings: { values: {} }, db: { $queryRawUnsafe: async () => [] } };
    await expect(
      assertSessionMayClaim(
        ctx as unknown as Parameters<typeof assertSessionMayClaim>[0],
        "session-b",
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses an unregistered session when the setting is on", async () => {
    await expect(assertSessionMayClaim(ctxWith(true), "session-c")).rejects.toThrow(ForbiddenError);
  });

  it("names the session and the field a caller would fix", async () => {
    // The message is what a session reads to work out what to do next, so
    // the session id being in it is behaviour, not decoration.
    const error = await assertSessionMayClaim(ctxWith(true), "session-d").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).message).toContain("session-d");
    expect((error as ForbiddenError & { fields?: string[] }).fields).toContain("sessionId");
  });

  it("does not read the database at all when the setting is off", async () => {
    // Cheapness is the point: the common path should not cost a query.
    let queried = false;
    const ctx = {
      settings: { values: { [KEY]: false } },
      db: {
        $queryRawUnsafe: async () => {
          queried = true;
          return [];
        },
      },
    };
    await assertSessionMayClaim(
      ctx as unknown as Parameters<typeof assertSessionMayClaim>[0],
      "session-e",
    );
    expect(queried).toBe(false);
  });
});
