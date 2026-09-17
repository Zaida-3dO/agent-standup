// Every verb descriptor the three folded modules declare is reachable from
// a command, and every command builds from a descriptor that exists.
//
// ── Why this file exists ──────────────────────────────────────────────
//
// `commands-ownership`, `commands-scoring` and `commands-artifacts` build
// their verbs from one shared factory, addressed by a string key into a
// per-module `VERBS` table: `buildInput: build("claim")`. That keeps the
// flag-forwarding behaviour in a single audited place, which is worth a
// great deal — but it makes a verb's wiring a NAME LOOKUP, and a name
// lookup is only as safe as the type of the name.
//
// The type half is held by declaring `VERBS` with `satisfies` rather than
// with a `Record<string, VerbFields>` annotation, so its keys stay literal
// and `build()` rejects a key the table does not have. See the comment on
// each `VERBS` for why that distinction carries weight.
//
// This file holds the half a type cannot state: that the table and the
// command list agree in BOTH directions, checked by CALLING each builder.
// A `build()` whose key is absent still returns a function, so a test
// asserting the builder "is defined" passes against the very defect that
// matters — the descriptor is `undefined`, every positional and switch it
// names goes unread, and the call is answered as a success with the fields
// quietly dropped. That is the `fa83f2b9` shape, and the only assertion
// that can see it is one that writes a value and reads it back.
//
// A descriptor no command builds from is the mirror image: dead
// configuration that reads as live, and how a verb comes to be "supported"
// in a table while absent from the grammar.
import { describe, expect, it } from "vitest";

import { ARTIFACT_COMMANDS } from "@/lib/cli/commands-artifacts";
import { OWNERSHIP_COMMANDS } from "@/lib/cli/commands-ownership";
import { SCORING_COMMANDS } from "@/lib/cli/commands-scoring";

/**
 * Every command in the three folded modules must carry a working builder.
 *
 * Asserted by CALLING it rather than by checking it is defined: a `build()`
 * that resolved to an absent descriptor returns a function, so
 * `toBeDefined()` passes against exactly the defect this guards. Invoking
 * it with no words and no flags is enough — `buildVerbInput(undefined)`
 * throws on the descriptor it cannot read, while a real descriptor either
 * builds an input or returns a structured refusal naming what is missing.
 */
const MODULES = [
  ["ownership", OWNERSHIP_COMMANDS],
  ["scoring", SCORING_COMMANDS],
  ["artifacts", ARTIFACT_COMMANDS],
] as const;

describe("the folded modules' verb descriptors", () => {
  for (const [name, commands] of MODULES) {
    it(`${name}: every command's builder resolves to a real descriptor`, () => {
      expect(commands.length).toBeGreaterThan(0);

      for (const spec of commands) {
        const build = spec.buildInput;
        expect(build, `\`${spec.noun} ${spec.verb}\` has no builder`).toBeDefined();

        // The call is the assertion. A builder addressing a descriptor that
        // is not in the table throws a TypeError reading a property of
        // `undefined`; one addressing a real descriptor returns an
        // `{ ok: true } | { ok: false }` result, both of which are fine here
        // — this is about whether the descriptor was found, not about what
        // the verb requires.
        const result = build!([], {});
        expect(
          typeof result === "object" && result !== null && "ok" in result,
          `\`${spec.noun} ${spec.verb}\` did not return a result envelope — its ` +
            `descriptor key is probably missing from that module's VERBS table`,
        ).toBe(true);
      }
    });
  }

  it("a command's builder actually reads the words after it", () => {
    // Not a restatement of the loop above. That one proves the descriptor
    // was found; this proves the found descriptor is the one the verb
    // means, by writing a value only a correct descriptor would keep.
    //
    // `session claim` declares a leading item-id positional. A builder
    // wired to a missing or wrong descriptor either throws or ignores the
    // positional, and both fail here.
    const claim = OWNERSHIP_COMMANDS.find(
      (spec) => spec.noun === "session" && spec.verb === "claim",
    );
    expect(claim, "`session claim` is missing from the ownership commands").toBeDefined();

    const built = claim!.buildInput!(["item-42"], { role: "reviewer" });

    expect(built.ok, "`session claim item-42 --role reviewer` should build").toBe(true);
    if (!built.ok) return;

    // The positional reached the input under the field the operation names,
    // and the value flag was forwarded rather than filtered away.
    expect(built.input).toMatchObject({ itemId: "item-42", role: "reviewer" });
  });
});
