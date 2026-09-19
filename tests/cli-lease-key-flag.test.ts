// `standup session claim --lease-key` reaches the operation as `leaseKey`.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// The lease key is the field a claim must carry to say which crew it belongs
// to, and the separate identity fields it stands in for cannot be retired
// until every adapter can carry one (`docs/plans/LEASE-KEY-LIFECYCLE.md`
// §3, §8).
// The command line could — but only under `--leaseKey`, because
// `passThroughFlags` copies flag names verbatim and nothing mapped the
// hyphenated spelling every other multi-word flag in the product uses.
// `--lease-key` arrived under the key `lease-key` and was refused by the
// operation's `.strict()` schema as unrecognised, which reads to a caller as
// "the command line does not support lease keys at all".
//
// ── What each case here would catch ─────────────────────────────────────
//
// The first case fails if the `rename` entry is deleted: the built input
// carries `lease-key` instead of `leaseKey`. Deleting one line of
// `HYPHENATED` in `commands-ownership.ts` breaks it.
//
// The second case is the one that stops the fix from being made the WRONG
// way. `commands-ownership.ts`'s header forbids listing value-flag names in
// the verb table, because such a list silently drops every flag missing from
// it — the defect `tests/cli-merged-builder-fields.test.ts` was written for.
// A rename maps a spelling; it must not filter. So this asserts that a flag
// with no rename entry still passes through untouched. Adding a `fields:`
// allow-list, or converting `rename` into a filter, fails it.
//
// The third pins the camelCase spelling that already worked, so a future
// rename cannot quietly become a *replacement* that breaks callers already
// passing `--leaseKey`.
import { describe, expect, it } from "vitest";

import { lookupCommand } from "@/lib/cli/commands";

/** Builds `standup session claim`'s input, failing the test if it refused. */
function buildClaim(
  rest: readonly string[],
  flags: Record<string, string | true>,
): Record<string, unknown> {
  const result = lookupCommand(["session", "claim"]);
  expect(result.ok, "`standup session claim` should be a bound command").toBe(true);
  if (!result.ok) throw new Error("unreachable");

  const built = result.match.command.buildInput(rest, flags);
  if (!built.ok) {
    throw new Error(`\`standup session claim\` refused: ${JSON.stringify(built.envelope)}`);
  }
  return built.input as Record<string, unknown>;
}

describe("the claim command carries a lease key", () => {
  it("maps `--lease-key` onto the schema's `leaseKey`", () => {
    const input = buildClaim(["item-1"], { "lease-key": "lk1.abc.def" });

    expect(input.leaseKey).toBe("lk1.abc.def");
    // The hyphenated spelling must not ALSO survive: an operation input
    // carrying both would be refused by `.strict()` for the one it does not
    // declare, so a rename that copied rather than moved would leave the
    // command broken in a way the assertion above alone would not show.
    expect(input).not.toHaveProperty("lease-key");
  });

  it("renames without filtering, so an unmapped flag still reaches the operation", () => {
    // `role` has no rename entry and is a real field on the claim schema.
    // If `rename` ever becomes an allow-list, this value disappears silently
    // — accepted, discarded, and answered with a success.
    const input = buildClaim(["item-1"], {
      "lease-key": "lk1.abc.def",
      role: "builder",
    });

    expect(input.role).toBe("builder");
    expect(input.leaseKey).toBe("lk1.abc.def");
  });

  it("still accepts the camelCase spelling that already worked", () => {
    const input = buildClaim(["item-1"], { leaseKey: "lk1.abc.def" });

    expect(input.leaseKey).toBe("lk1.abc.def");
  });
});
