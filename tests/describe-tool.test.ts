// `describe_tool` and the refusals that route callers to it. MILESTONES.md #111.
//
// ── What these tests are actually trying to catch ───────────────────────
//
// The failure this row exists to fix is a *silent* one: documentation that
// is wrong, or absent, costs a round trip and never fails a build. So the
// assertions here are chosen to be ones that break when the behaviour
// regresses, rather than ones that restate the implementation —
//
//   - the contract is asserted to contain the **specific conditional rules**
//     that were actually discovered by being refused (`originPersonId` when
//     `originType` is `person`; `how_verified` when `user_facing` is false),
//     not merely that "some rules" came back, which a `rules: []` would
//     satisfy;
//   - the field list is asserted against facts read from the **schema**
//     (`priority`'s four enum members, its `P2` default, `originType` being
//     required), so a walker that returned a plausible-looking but empty or
//     stale list fails;
//   - the routing pointer is asserted **per surface**, because naming the
//     wrong surface is the defect and a test that only checks "the string
//     `describe_tool` appears" would pass while telling an MCP caller to run
//     a terminal command;
//   - the multi-fault case counts findings, because the reported failure was
//     two problems reading as one.
import { describe, expect, it } from "vitest";
import {
  InvalidInputError,
  NotFoundError,
  OPERATION_REGISTRY,
  ServiceRuntime,
  describeFields,
  isServiceError,
  type ServiceContext,
  type ToolContract,
  type TransactionHandle,
} from "@/lib/service";
import type { ServiceFacts } from "@/lib/service/operations/describe-tool";
import { currentBuildInfo, DEV_VERSION, UNKNOWN_REVISION } from "@/lib/build-info";
import { OPERATION_NAMES } from "@/lib/service/registry";
import { SHIPPED_CHAR_CAP, SHIPPED_MAX, SHIPPED_MIN } from "@/lib/service/summaries/validate";
import { invocationFor, invocationWithArgumentFor, surfaceForTransport } from "@/lib/surfaces";
import { assessVersion } from "@/lib/sessions";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";
import { z } from "zod";
import { FINDING_SEVERITIES, parseFindings } from "@/lib/findings";

/** A handle no test here needs to reach — `describe_tool` touches no table. */
const inertHandle: TransactionHandle = {
  $queryRawUnsafe: async <T = unknown>(): Promise<T> => [] as T,
  $executeRawUnsafe: async (): Promise<number> => 0,
};

function runtime(): ServiceRuntime {
  return new ServiceRuntime({
    transaction: (body) => body(inertHandle),
    resolveSnapshot: async () => defaultSnapshot(),
  });
}

/** Calls an operation and returns the `ServiceError` it refused with. */
async function refusal(
  name: string,
  input: unknown,
  transport?: string,
): Promise<InvalidInputError | NotFoundError> {
  try {
    await runtime().call(name, input, transport ? { caller: { transport } } : undefined);
  } catch (error) {
    if (isServiceError(error)) return error as InvalidInputError;
    throw error;
  }
  throw new Error(`Expected ${name} to refuse.`);
}

async function contractFor(tool: string): Promise<ToolContract> {
  return (await runtime().call("describe_tool", { tool })) as ToolContract;
}

/** Every rule of a contract, flattened, so a test can search the prose once. */
function ruleText(contract: ToolContract): string {
  return contract.rules.map((rule) => rule.rule).join("\n");
}

describe("describe_tool returns one tool's full contract", () => {
  it("is a registered operation, so every adapter exposes it without per-adapter work", () => {
    // The whole reason it is an operation rather than an MCP-only affordance:
    // the CLI and HTTP adapters derive from this registry too, so a caller
    // refused over HTTP is pointed at something HTTP actually has.
    expect(OPERATION_NAMES).toContain("describe_tool");
    expect(OPERATION_REGISTRY.describe_tool.kind).toBe("read");
  });

  it("answers for create_item with the conditional rule its schema cannot state", async () => {
    const contract = await contractFor("create_item");

    // The exact refinement three field reports discovered by being refused.
    // Asserting the *pairing* — the field and the condition that triggers it
    // — rather than the presence of the word `originPersonId`, which a rule
    // about something else entirely could satisfy.
    const rule = contract.rules.find((entry) => entry.fields.includes("originPersonId"));
    expect(rule).toBeDefined();
    expect(rule!.rule).toContain("originType");
    expect(rule!.rule).toContain("person");
    expect(rule!.fields).toContain("originType");
  });

  it("answers for complete_item with the whole conditional matrix", async () => {
    const contract = await contractFor("complete_item");
    const text = ruleText(contract);

    // `shipped`'s cap, read from the validator's own constants rather than
    // retyped. A literal `1[–-]5` here survives the pair of edits that
    // hardcodes the generated sentence *and* raises the validator's cap —
    // mutation testing finds exactly that pair, leaving documentation that
    // states a limit the validator does not enforce. Building the
    // expectation from the constants means the test fails if the
    // interpolation is dropped, and fails again if the constants move
    // without this file noticing, which is the drift `describe_tool` exists
    // to prevent.
    expect(text).toMatch(new RegExp(`shipped[\\s\\S]*${SHIPPED_MIN}[–-]${SHIPPED_MAX}`));
    // The character cap travels in the same sentence and is derived the same
    // way — it is the other number a caller is refused by.
    expect(text).toContain(String(SHIPPED_CHAR_CAP));

    // The conditional half, which is the part that is genuinely invisible:
    // `how_verified` is required when `user_facing` is FALSE, and
    // `what_to_test` when it is true. Getting these the wrong way round is
    // the single most likely documentation error, so both directions are
    // asserted rather than just "both fields are mentioned".
    const howVerified = contract.rules.find((entry) =>
      entry.fields.includes("summary.how_verified"),
    );
    expect(howVerified).toBeDefined();
    expect(howVerified!.rule).toMatch(/user_facing[\s\S]*false/);

    const whatToTest = contract.rules.find((entry) =>
      entry.fields.includes("summary.what_to_test"),
    );
    expect(whatToTest).toBeDefined();
    expect(whatToTest!.rule).toMatch(/user_facing[\s\S]*true/);
  });

  it("gives record_artifact.findings a concrete type, an element shape and a worked example", async () => {
    // Row 94eed34b: `findings` was declared `z.unknown()`, so this field
    // reported `type: "unknown"` with `rules: []` on a tool where every
    // other field is typed — the one field that required a guess was the
    // one field with no contract. Two reviewers guessed wrong.
    const contract = await contractFor("record_artifact");

    const field = contract.fields.find((entry) => entry.name === "findings");
    expect(field).toBeDefined();
    // Asserts the real rendering rather than merely `not.toBe("unknown")`,
    // so any untyped node in this position fails the test.
    // Single-character mutation this catches: declaring `findings` in
    // record-artifact.ts as `z.unknown()` makes this "unknown".
    expect(field!.type).toBe("array<object>");
    expect(field!.required).toBe(false);

    // The element shape has to be reachable, not just the container's type.
    const rule = contract.rules.find((entry) => entry.fields.includes("findings"));
    expect(rule).toBeDefined();
    expect(rule!.rule).toContain("text");
    expect(rule!.rule).toContain("severity");
    // The vocabulary is interpolated from FINDING_SEVERITIES rather than
    // retyped, so the documented list cannot drift from the enforced one.
    const text = ruleText(contract);
    for (const severity of FINDING_SEVERITIES) {
      expect(text).toContain(severity);
    }
    // The "send the array, not a string of it" instruction — the exact
    // near-miss that cost the round trip.
    expect(text).toMatch(/not a JSON string/i);

    // A worked example a caller can copy, and it must be a real call: the
    // operation's own schema has to accept it. A prose example that the
    // validator would refuse is worse than none.
    const example = contract.example as Record<string, unknown> | undefined;
    expect(example).toBeDefined();
    expect(Array.isArray(example!.findings)).toBe(true);
    const parsedExample = OPERATION_REGISTRY.record_artifact.input.safeParse(example);
    expect(parsedExample.success).toBe(true);
    // And the example's findings survive the runtime validator too — the
    // two doors have to agree, which is the whole reason both exist.
    expect(() => parseFindings(example!.findings)).not.toThrow();
    expect(parseFindings(example!.findings)[0]!.severity).toBe("medium");
  });

  it("derives the field list from the schema, including enums and defaults", async () => {
    const contract = await contractFor("create_item");
    const byName = new Map(contract.fields.map((field) => [field.name, field]));

    // Read off the schema, so this fails if the walker returns a stale or
    // empty list rather than reading `inputSchema`.
    expect(byName.get("priority")?.enumValues).toEqual(["P0", "P1", "P2", "P3"]);
    expect(byName.get("priority")?.defaultValue).toBe("P2");
    // A defaulted field may be omitted — the distinction a caller acts on.
    expect(byName.get("priority")?.required).toBe(false);

    // `originType` is optional *in the schema* and required *in practice*,
    // which is the exact shape this call exists to describe: a session that
    // declared a person at registration inherits it, and one that did not is
    // refused for omitting it (MILESTONES.md #111). JSON Schema can express
    // neither half, so the schema says "optional" and the rule below says
    // what a caller actually has to do — and asserting the two together is
    // what pins the claim, because either alone reads as a plain optional
    // field.
    expect(byName.get("originType")?.required).toBe(false);
    expect(byName.get("originType")?.enumValues).toEqual(["person", "source", "auto"]);

    const originRule = contract.rules.find((entry) => entry.fields.includes("originType"));
    expect(originRule).toBeDefined();
    expect(originRule!.rule).toMatch(/session/i);

    // `originPersonId` is optional *in the schema* — which is exactly why
    // the rule above has to exist. Asserting both together is what pins the
    // claim this row is built on.
    expect(byName.get("originPersonId")?.required).toBe(false);
  });

  it("names how to call the described tool on each surface", async () => {
    const contract = await contractFor("create_item");
    expect(contract.invocation.mcp).toBe("create_item");
    expect(contract.invocation.cli).toBe("standup create item");
  });

  it("returns an empty rules list, not an error, for a tool fully described by its schema", async () => {
    // `get_item` declares no contract. An empty list is the honest answer
    // ("nothing else to know") and a caller must be able to tell it apart
    // from a failure — so this asserts it succeeds AND that the list is
    // empty, not merely that it did not throw.
    const contract = await contractFor("get_item");
    expect(contract.rules).toEqual([]);
    expect(contract.fields.length).toBeGreaterThan(0);
  });
});

describe("describe_tool rejects what it should", () => {
  it("refuses an unknown tool and lists the ones that exist", async () => {
    const error = await refusal("describe_tool", { tool: "no_such_tool" });
    expect(error.code).toBe("not_found");
    expect(error.fields).toContain("tool");
    // The list is the point: a caller with a near-miss name gets the right
    // one from this refusal instead of making a second call for it.
    expect(error.message).toContain("create_item");
    expect((error.details as { known: string[] }).known).toEqual(OPERATION_NAMES);
  });

  it("refuses an empty tool name", async () => {
    const error = await refusal("describe_tool", { tool: "   " });
    expect(error.code).toBe("invalid_input");
    expect(error.fields).toContain("tool");
  });

  it("refuses an unrecognised key rather than ignoring it", async () => {
    const error = await refusal("describe_tool", { tool: "create_item", verbose: true });
    expect(error.code).toBe("invalid_input");
  });
});

describe("the field walker reads what the schema says", () => {
  it("separates optional, nullable and defaulted, which mean different things to a caller", () => {
    const fields = describeFields(
      z.object({
        plain: z.string(),
        optional: z.string().optional(),
        nullable: z.string().nullable(),
        defaulted: z.string().default("x"),
        both: z.string().nullable().optional(),
      }),
    );
    const byName = new Map(fields.map((field) => [field.name, field]));

    expect(byName.get("plain")).toMatchObject({ required: true, type: "string" });
    expect(byName.get("optional")?.required).toBe(false);
    // Nullable is NOT optional: the key must be present, its value may be
    // null. Collapsing the two would tell a caller they can omit a field
    // that the schema requires.
    expect(byName.get("nullable")).toMatchObject({ required: true, nullable: true });
    expect(byName.get("defaulted")).toMatchObject({ required: false, defaultValue: "x" });
    expect(byName.get("both")).toMatchObject({ required: false, nullable: true });
  });

  it("finds the shape under a .refine(), which is where both documented operations put it", () => {
    // `create_item` and `complete_item` both end in `.refine()`, wrapping the
    // object in a ZodEffects with no `.shape`. A walker that read `.shape`
    // directly would return nothing for exactly the two tools this row is
    // about — and would do so silently.
    const fields = describeFields(
      z
        .object({ a: z.string(), b: z.number() })
        .strict()
        .refine(() => true),
    );
    expect(fields.map((field) => field.name)).toEqual(["a", "b"]);
  });

  it("names element types for arrays", () => {
    const fields = describeFields(
      z.object({ tags: z.array(z.string()), entries: z.array(z.object({ t: z.string() })) }),
    );
    const byName = new Map(fields.map((field) => [field.name, field.type]));
    expect(byName.get("tags")).toBe("array<string>");
    expect(byName.get("entries")).toBe("array<object>");
  });

  it("returns an empty list rather than throwing for a non-object schema", () => {
    // A degraded answer beats a failed call: the rules half of a contract is
    // still worth returning if the field walk finds nothing.
    expect(describeFields(z.string())).toEqual([]);
    expect(describeFields(undefined)).toEqual([]);
  });

  it("reads a z.nativeEnum's members instead of throwing on them", () => {
    // Zod stores `z.enum`'s members as an array and `z.nativeEnum`'s as the
    // enum *object*, which is not iterable. An unguarded spread of
    // `_def.values` therefore throws a TypeError for the second shape — out
    // of the one tool a caller reaches for *after* being refused, which is
    // the worst possible moment for it. No registered operation is typed
    // `nativeEnum`, so this asserts against a schema built here rather than
    // a real one; the point is that the walker survives the first that is.
    const fields = describeFields(z.object({ colour: z.nativeEnum({ Red: "red", Blue: "blue" }) }));
    const colour = fields.find((field) => field.name === "colour");
    expect(colour?.enumValues).toEqual(["red", "blue"]);
    // The type name still falls through to `unknown`, which is this module's
    // documented answer for a node kind it does not model. Reporting the
    // members without claiming to have modelled the kind is the honest pair.
    expect(colour?.type).toBe("unknown");
  });

  it("omits a numeric enum's reverse-mapping keys, which the schema rejects", () => {
    // A numeric TypeScript enum compiles to an object carrying both
    // directions — `{ A: 0, B: 1, 0: "A", 1: "B" }` — and Zod accepts only
    // `0` and `1`. A walker that reported every `Object.values` entry would
    // document `"A"` and `"B"` as permitted, and a caller who believed it
    // would be refused by the very schema they had just read. The list shown
    // and the list checked against have to be the same list.
    // Written as the object literal a numeric TypeScript enum actually
    // compiles to, rather than declared with `enum`, because the two are the
    // same value at runtime and a literal keeps the fixture readable as the
    // shape under test.
    const numeric = { A: 0, B: 1, 0: "A", 1: "B" };
    const schema = z.nativeEnum(numeric);
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse("A").success).toBe(false);

    const fields = describeFields(z.object({ level: schema }));
    const level = fields.find((field) => field.name === "level");
    expect(level?.enumValues).toEqual(["0", "1"]);
    expect(level?.enumValues).not.toContain("A");
  });

  it("adds no enumValues key for an enum that resolves to no members", () => {
    // `enumValues: []` would claim an enum permitting nothing, which is a
    // different and wrong statement from "this field is not an enum". The
    // empty object reaches the resolver with a truthy `values`, so the
    // early return for an absent one does not cover it.
    const fields = describeFields(z.object({ nothing: z.nativeEnum({}) }));
    expect(fields[0]).not.toHaveProperty("enumValues");
  });

  it("adds no enumValues key at all for a field that is not an enum", () => {
    // `enumValues: []` would be a claim — an enum permitting nothing — where
    // the truth is that the question does not apply. Kills the mutant that
    // returns an empty array instead of omitting the key.
    const fields = describeFields(z.object({ name: z.string() }));
    expect(fields[0]).not.toHaveProperty("enumValues");
  });
});

describe("a shape refusal names the call that would have prevented it", () => {
  it("points at describe_tool for the operation that refused", async () => {
    const error = await refusal("create_item", { title: "x" });
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("describe_tool");
    // Named for the operation, not generically: a pointer that does not
    // carry the tool name makes the caller supply the argument themselves.
    expect(error.message).toContain("create_item");
  });

  it("spells the pointer for MCP when the caller is on MCP", async () => {
    const error = await refusal("create_item", { title: "x" }, "mcp-http");
    expect(error.message).toContain('describe_tool("create_item")');
    // The defect being fixed: a terminal command shown to a caller who has
    // no terminal.
    expect(error.message).not.toContain("standup ");
  });

  it("spells the pointer for the command line when the caller is on the command line", async () => {
    const error = await refusal("create_item", { title: "x" }, "cli-direct");
    expect(error.message).toContain("standup describe tool create_item");
    expect(error.message).not.toContain('describe_tool("create_item")');
  });

  it("names both spellings when the transport is unknown, rather than guessing one", async () => {
    const error = await refusal("create_item", { title: "x" });
    expect(error.message).toContain('describe_tool("create_item")');
    expect(error.message).toContain("standup describe tool create_item");
  });

  it("routes an unregistered operation name too", async () => {
    const error = await refusal("no_such_tool", {}, "mcp-http");
    expect(error.code).toBe("not_found");
    expect(error.message).toContain('describe_tool("no_such_tool")');
  });

  it("routes from complete_item, the other operation with invisible rules", async () => {
    const error = await refusal("complete_item", { id: "i", to: "merged" }, "mcp-stdio");
    expect(error.message).toContain('describe_tool("complete_item")');
  });
});

describe("a refusal with several faults reads as several findings", () => {
  it("numbers them and states the count", async () => {
    // The real report: one call refused for a bad `priority` AND an
    // unrecognised key at once, read by the session as a single confusing
    // message. Both faults are independent and both have to be fixed.
    const error = await refusal("create_item", {
      title: "x",
      body: "b",
      area: "a",
      originType: "auto",
      priority: "normal",
      urgency: "high",
    });

    expect(error.message).toContain("2 problems");
    expect(error.message).toContain("1.");
    expect(error.message).toContain("2.");
    // Still routed — a multi-fault refusal is the one that most needs the
    // contract.
    expect(error.message).toContain("describe_tool");
  });

  it("carries the findings structurally, so an adapter need not split the message", async () => {
    const error = await refusal("create_item", {
      title: "x",
      body: "b",
      area: "a",
      originType: "auto",
      priority: "normal",
      urgency: "high",
    });

    const findings = (error.details as { findings: { field: string; message: string }[] }).findings;
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.field)).toContain("priority");
  });

  it("does not number a single fault", async () => {
    // A list of one is noise, and the count is not information when it is
    // one. This is the assertion that fails if the multi-fault branch is
    // applied unconditionally.
    const error = await refusal("describe_tool", { tool: "" });
    expect(error.message).not.toContain("1 problems");
    expect(error.message).not.toContain("  1.");
  });

  it("names the field on each finding, because Zod's own text often does not", async () => {
    const error = await refusal("create_item", { title: "x" });
    // "Required" alone says nothing about where. The prefix is what makes a
    // finding actionable.
    expect(error.message).toMatch(/`(body|area|originType)`/);
  });
});

describe("a refusal names the surface the caller is on", () => {
  it("maps every transport to the surface a caller types on", () => {
    expect(surfaceForTransport("mcp-http")).toBe("mcp");
    expect(surfaceForTransport("mcp-stdio")).toBe("mcp");
    // Both command-line bindings are the same surface: the hook-variant
    // distinction `sessions.ts` draws between them does not change how a
    // command is spelled.
    expect(surfaceForTransport("cli-direct")).toBe("cli");
    expect(surfaceForTransport("cli-http")).toBe("cli");
    expect(surfaceForTransport("http")).toBe("http");
    expect(surfaceForTransport(undefined)).toBeUndefined();
    expect(surfaceForTransport("carrier-pigeon")).toBeUndefined();
  });

  it("tells an MCP caller to register with the tool name, not the terminal command", () => {
    // The reported instance: the unregistered-session refusal named
    // `standup session register` to callers reading it over MCP, where the
    // call is `register_session`.
    const assessment = assessVersion({
      variant: undefined,
      reportedVersion: null,
      surface: "mcp",
    });
    expect(assessment.versionPermitsClaim).toBe(false);
    expect(assessment.message).toContain("register_session");
    expect(assessment.message).not.toContain("standup session register");
  });

  it("still tells a command-line caller the command-line spelling", () => {
    const assessment = assessVersion({
      variant: undefined,
      reportedVersion: null,
      surface: "cli",
    });
    expect(assessment.message).toContain("standup register session");
  });

  it("names both when the surface is unknown", () => {
    const assessment = assessVersion({ variant: undefined, reportedVersion: null });
    expect(assessment.message).toContain("register_session");
    expect(assessment.message).toContain("standup register session");
  });

  it("leaves the verdicts that name no command alone", () => {
    // `incompatible` says "update the hook, then re-register" and names no
    // spelling, which is correct on every surface. This asserts the change
    // did not spread into messages that were already right.
    const assessment = assessVersion({ variant: "cli", reportedVersion: 0 });
    expect(assessment.message).not.toContain("register_session");
    expect(assessment.message).not.toContain("standup ");
  });

  it("formats an invocation per surface", () => {
    expect(invocationFor("register_session", "mcp")).toBe("`register_session`");
    expect(invocationFor("register_session", "cli")).toBe("`standup register session`");
    expect(invocationWithArgumentFor("describe_tool", "create_item", "mcp")).toBe(
      '`describe_tool("create_item")`',
    );
    expect(invocationWithArgumentFor("describe_tool", "create_item", "cli")).toBe(
      "`standup describe tool create_item`",
    );
  });
});

describe("the contract cannot drift from what is enforced", () => {
  it("describes every registered operation without throwing", async () => {
    // A contract that names a field the schema does not have, or a walker
    // that trips over one operation's schema shape, is caught here rather
    // than by the caller who happened to ask about that tool.
    for (const name of OPERATION_NAMES) {
      const contract = await contractFor(name);
      expect(contract.name).toBe(name);
    }
  });

  it("only ever names fields that the described tool actually has", async () => {
    // The drift that would make this whole feature worse than nothing:
    // documentation pointing at a field the schema does not have. Every
    // rule's `fields` must resolve against the live schema — allowing for
    // dotted paths into a nested object, whose root is what is checked.
    for (const name of OPERATION_NAMES) {
      const contract = await contractFor(name);
      const known = new Set(contract.fields.map((field) => field.name));
      for (const rule of contract.rules) {
        for (const field of rule.fields) {
          expect(known, `${name}: rule names unknown field \`${field}\``).toContain(
            field.split(".")[0],
          );
        }
      }
    }
  });

  it("gives every declared rule a non-empty statement and at least one field", async () => {
    // A rule with no fields cannot be matched to the refusal that raised it,
    // which is the one thing `fields` is for.
    for (const name of OPERATION_NAMES) {
      const contract = await contractFor(name);
      for (const rule of contract.rules) {
        expect(rule.fields.length).toBeGreaterThan(0);
        expect(rule.rule.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("declares an example that its own schema accepts", async () => {
    // An example a caller copies and is refused by is worse than no example.
    // Checked against the live schema, so an example left behind by a schema
    // change fails here.
    for (const name of OPERATION_NAMES) {
      const contract = await contractFor(name);
      if (contract.example === undefined) continue;
      const operation = OPERATION_REGISTRY[name as keyof typeof OPERATION_REGISTRY];
      const parsed = (
        operation as { input: { safeParse: (v: unknown) => { success: boolean } } }
      ).input.safeParse(contract.example);
      expect(parsed.success, `${name}'s example does not satisfy its own schema`).toBe(true);
    }
  });
});

describe("describe_tool touches no table", () => {
  it("answers against a handle that refuses every query", async () => {
    // It is the call a caller makes when something has already gone wrong,
    // so it must not be the call that needs the database to be healthy.
    const exploding: TransactionHandle = {
      $queryRawUnsafe: async () => {
        throw new Error("the database was queried");
      },
      $executeRawUnsafe: async () => {
        throw new Error("the database was written");
      },
    };
    const service = new ServiceRuntime({
      transaction: (body) => body(exploding),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    const contract = (await service.call("describe_tool", { tool: "claim" })) as ToolContract;
    expect(contract.name).toBe("claim");
  });
});

describe("the summary contract states its two element types", () => {
  // ── Why these exist ───────────────────────────────────────────────────
  //
  // A reporter closing rows on 2026-08-31 sent `what_to_test` as bare
  // strings, was refused, and lost ~8 calls across 4 items to it. The
  // validator's refusal was correct and named the shape; what sent them
  // down the wrong path first was this contract, which said only "1-3
  // entries, each `text` at most 240 characters". They read `text` as the
  // internal field name of a string entry — a fair reading of that
  // sentence. Then, having discovered the object shape, they applied it to
  // `watch_for` too and were refused again, because these two adjacent
  // list fields take opposite element types.
  //
  // So the contract has to state the shape positively and state the
  // asymmetry. Both assertions below fail if that prose is dropped back to
  // naming the cap alone.

  it("shows what_to_test's entry as an object literal, not just its text cap", async () => {
    const contract = await contractFor("complete_item");
    const rule = contract.rules.find((entry) => entry.fields.includes("summary.what_to_test"));
    expect(rule).toBeDefined();
    // The literal a caller can copy. Fails if the rule goes back to
    // describing the entry only as "each `text` at most N characters",
    // which is the exact wording that was misread as "an array of strings".
    expect(rule!.rule).toContain('{"text": "..."}');
    // And says so in words as well as by example, because the example
    // alone can be skimmed past.
    expect(rule!.rule).toMatch(/objects, not strings/i);
  });

  it("warns that watch_for takes the opposite element type", async () => {
    const contract = await contractFor("complete_item");
    const rule = contract.rules.find((entry) => entry.fields.includes("summary.watch_for"));
    expect(rule).toBeDefined();
    // Fails if the asymmetry warning is removed from watch_for's own rule.
    // This is the half that catches the *second* mistake — the one that
    // only bites a caller who got what_to_test right — so it deliberately
    // asserts on watch_for's rule rather than anywhere in the contract.
    expect(rule!.rule).toContain("a string");
    expect(rule!.rule).toContain('{"text": "..."}');
    expect(rule!.rule).toContain("what_to_test");
  });

  it("keeps the two rules disagreeing about element type, which is the real contract", async () => {
    const contract = await contractFor("complete_item");
    const whatToTest = contract.rules.find((e) => e.fields.includes("summary.what_to_test"))!;
    const watchFor = contract.rules.find((e) => e.fields.includes("summary.watch_for"))!;
    // The asymmetry is a fact about the schema, so the prose describing it
    // must not be copy-pasted into agreement. Fails if someone "fixes" the
    // inconsistency by making both rules claim the same element type —
    // which would be documentation that contradicts the validator.
    expect(whatToTest.rule).toMatch(/objects, not strings/i);
    expect(watchFor.rule).toMatch(/\*\*not\*\* an object/i);
  });
});

describe("describe_tool with no tool answers what the build is", () => {
  // ── Why these tests exist ─────────────────────────────────────────────
  //
  // `build`, `limits` and `settingsRevision` were `service_info`'s, and
  // `service_info` is waived off both MCP transports. `get_settings` and
  // `get_setting` are waived too, so if this branch regresses there is **no
  // MCP tool that reports a setting value at all** — and the regression is
  // silent, because a caller who never receives a limit does not know one
  // exists. These assert the specific fields rather than "an object came
  // back", so an empty or partial answer fails.

  // ── Why this snapshot is deliberately NOT the defaults ────────────────
  //
  // Every value here is overridden to something the defaults are not, and
  // the revision is non-zero. Asserting against `defaultSnapshot()` looked
  // right and was hollow: `items.max_depth` defaults to 6, so a handler
  // that returned a hardcoded `6` — reading no settings at all — passed.
  // Mutation testing caught exactly that. Values that differ from the
  // defaults are what make "did it read the snapshot" observable.
  const OVERRIDDEN_DEPTH = 4;
  const OVERRIDDEN_WAIT = 97;
  const OVERRIDDEN_REVISION = 512n;

  function overriddenSnapshot() {
    return resolveSettings({
      overrides: [
        { key: "items.max_depth", value: OVERRIDDEN_DEPTH },
        { key: "crew.wait_timeout_seconds", value: OVERRIDDEN_WAIT },
      ],
      revision: OVERRIDDEN_REVISION,
    });
  }

  async function facts(): Promise<ServiceFacts> {
    const rt = new ServiceRuntime({
      transaction: (body) => body(inertHandle),
      resolveSnapshot: async () => overriddenSnapshot(),
    });
    return (await rt.call("describe_tool", {})) as ServiceFacts;
  }

  it("carries the limits a caller is refused against, read from the live settings", async () => {
    const answer = await facts();
    // Both differ from the registry defaults, so a handler returning
    // constants — or reading the wrong setting key — fails rather than
    // coinciding. `maxDepth` is the ceiling create_work refuses a too-deep
    // subtask against; a wrong value misleads a caller into a refusal it
    // was told it would not get.
    expect(answer.limits.maxDepth).toBe(OVERRIDDEN_DEPTH);
    expect(answer.limits.waitTimeoutSeconds).toBe(OVERRIDDEN_WAIT);
    // And neither coincides with the default, which is what makes the two
    // assertions above capable of failing at all.
    expect(OVERRIDDEN_DEPTH).not.toBe(defaultSnapshot().values["items.max_depth"]);
    expect(OVERRIDDEN_WAIT).not.toBe(defaultSnapshot().values["crew.wait_timeout_seconds"]);
  });

  it("carries the settings revision as a string, because JSON has no bigint", async () => {
    const answer = await facts();
    // The type matters as much as the value: the revision is a bigint, and
    // an adapter serialising one throws. Fails if the `.toString()` is
    // dropped — which typechecks against a looser type but breaks the wire.
    expect(typeof answer.settingsRevision).toBe("string");
    expect(answer.settingsRevision).toBe(OVERRIDDEN_REVISION.toString());
  });

  it("carries the running build, read per call rather than captured at import", async () => {
    // ── Why the environment is set here ────────────────────────────────
    //
    // Comparing to a bare `currentBuildInfo()` was hollow: on an
    // unreleased checkout both sides are the development fallbacks
    // (`0.0.0-dev` / `unknown`), so a handler returning those as a frozen
    // literal — reading the environment never — passed. Mutation testing
    // caught it. Setting a released-looking environment makes the two
    // distinguishable, and also exercises the `released: true` branch that
    // a dev checkout never reaches.
    const saved = {
      APP_VERSION: process.env.APP_VERSION,
      APP_REVISION: process.env.APP_REVISION,
      APP_BUILD_TIME: process.env.APP_BUILD_TIME,
    };
    process.env.APP_VERSION = "9.9.9";
    process.env.APP_REVISION = "0123456789abcdef0123456789abcdef01234567";
    process.env.APP_BUILD_TIME = "2026-01-02T03:04:05.000Z";
    try {
      const answer = await facts();
      expect(answer.build.version).toBe("9.9.9");
      expect(answer.build.revision).toBe("0123456789abcdef0123456789abcdef01234567");
      expect(answer.build.buildTime).toBe("2026-01-02T03:04:05.000Z");
      // Derived from the other two being present — the one boolean a caller
      // reads instead of knowing which sentinels mean absence.
      expect(answer.build.released).toBe(true);
      // Read per call, not captured at import: this is the property that
      // makes "what is deployed" answerable in one call with no shell on
      // the deploy host, which is the incident build-info was created for.
      expect(answer.build).toEqual(currentBuildInfo());
      // And it is genuinely not the development fallback, which is what
      // makes every assertion above capable of failing.
      expect(answer.build.version).not.toBe(DEV_VERSION);
      expect(answer.build.revision).not.toBe(UNKNOWN_REVISION);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("returns no tool catalogue, because tools/list already sent one", async () => {
    // The catalogue was the duplication that justified waiving
    // `service_info` — reproducing it here would rebuild the waste. It would
    // also be wrong: the registry's name list is every REGISTERED operation,
    // so it names waived tools (`backfill`, `loop_list`) an MCP caller
    // cannot call. Fails if someone "helpfully" adds the list back.
    const answer = (await facts()) as ServiceFacts & { operations?: unknown; tools?: unknown };
    expect(answer.operations).toBeUndefined();
    expect(answer.tools).toBeUndefined();
  });

  it("still refuses an unknown tool name rather than treating it as absent", async () => {
    // A caller who sent a name that is merely wrong must get "no such tool",
    // not build info — an answer to a question they did not ask is worse
    // than the refusal.
    const error = await refusal("describe_tool", { tool: "no_such_operation" });
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("no_such_operation");
  });

  it("refuses a blank tool instead of reading it as omitted", async () => {
    // ── Why this asserts on the SCHEMA and not only the handler ─────────
    //
    // The handler branches on `tool === undefined`. Mutating that to a
    // falsy check (`!input.tool`) survives every other test here, because
    // no input can reach the handler with a defined-but-falsy `tool`: the
    // schema's `.min(1)` on a trimmed string refuses `""` and `"   "`
    // first. That makes the mutant *equivalent* rather than uncaught —
    // but only while the `.min(1)` holds.
    //
    // So this pins the property that makes it equivalent. Drop the
    // `.trim()` or the `.min(1)` and a blank name would reach the handler,
    // where a falsy check would silently answer with build info for a
    // caller who asked about a tool. Both spellings are asserted because
    // `""` is caught by `min` alone while `"   "` needs the `trim` too.
    for (const blank of ["", "   "]) {
      const error = await refusal("describe_tool", { tool: blank });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("tool");
    }
  });

  it("still describes a named tool, so both questions are answerable from one call", async () => {
    const contract = await contractFor("create_item");
    expect(contract.name).toBe("create_item");
    expect(contract.fields.length).toBeGreaterThan(0);
  });
});

/** Silences the unused-import lint for a type used only in annotations above. */
export type _Ctx = ServiceContext;
