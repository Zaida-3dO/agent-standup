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
  type OperationRule,
  type ToolContract,
  type TransactionHandle,
} from "@/lib/service";
import type { ServiceFacts } from "@/lib/service/operations/describe-tool";
import { currentBuildInfo, DEV_VERSION, UNKNOWN_REVISION } from "@/lib/build-info";
import { OPERATION_NAMES } from "@/lib/service/registry";
import { CHECK_RUN_STATUSES } from "@/lib/check-runs";
import { SHIPPED_CHAR_CAP, SHIPPED_MAX, SHIPPED_MIN } from "@/lib/service/summaries/validate";
import { HEADLINE_MAX_CHARS } from "@/lib/service/items/row";
import { invocationFor, invocationWithArgumentFor, surfaceForTransport } from "@/lib/surfaces";
import { assessVersion } from "@/lib/sessions";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";
import { z } from "zod";
import { FINDING_SEVERITIES, parseFindings } from "@/lib/findings";
import { FACETS, MAX_RUN_SCORE, MIN_RUN_SCORE } from "@/lib/scoring/run-scores";
import { INTERVENTION_OUTCOMES } from "@/lib/interventions/capture";

/**
 * A handle almost no test here needs to reach.
 *
 * `describe_tool` touches one table now, not zero: the no-`tool` branch
 * reads `_prisma_migrations` for the migration-drift report
 * (`migrationDriftReport` in the operation itself). Every query this handle
 * receives answers `[]`, which the drift comparison reads as "no migrations
 * recorded as applied yet" — `severity: "none"`, not a failure — so tests
 * with no opinion about migration state are unaffected by the read they did
 * not know they were making. The migration-drift describe_tool tests below
 * build their own handle that answers the query with real rows.
 */
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

/**
 * The declared rules of an operation that is supposed to declare some.
 *
 * `ToolContract.rules` is optional: it is omitted entirely for an operation
 * declaring no contract, which is the distinction the "declares no contract
 * vs declares an empty one" tests below exercise directly. Every OTHER test
 * here is about an operation that does declare rules, and asserting the key
 * is present before reading it keeps those tests honest — if a contract were
 * dropped, this fails loudly at the operation under test rather than
 * silently reading an empty list and passing a `.find(...)` that was never
 * going to match.
 */
function declaredRules(contract: ToolContract): readonly OperationRule[] {
  expect(contract.rules, `${contract.name} should declare a contract`).toBeDefined();
  return contract.rules!;
}

/** Every rule of a contract, flattened, so a test can search the prose once. */
function ruleText(contract: ToolContract): string {
  return declaredRules(contract)
    .map((rule) => rule.rule)
    .join("\n");
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
    const rule = declaredRules(contract).find((entry) => entry.fields.includes("originPersonId"));
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
    const howVerified = declaredRules(contract).find((entry) =>
      entry.fields.includes("summary.how_verified"),
    );
    expect(howVerified).toBeDefined();
    expect(howVerified!.rule).toMatch(/user_facing[\s\S]*false/);

    const whatToTest = declaredRules(contract).find((entry) =>
      entry.fields.includes("summary.what_to_test"),
    );
    expect(whatToTest).toBeDefined();
    expect(whatToTest!.rule).toMatch(/user_facing[\s\S]*true/);
  });

  it("states check_run's required status on record_artifact's contract", async () => {
    // `kind` is a flat enum, so a caller picking `check_run` sees nothing
    // saying its `body` is required or what may go in it — the rule lives in
    // the handler and refuses only after the call. Every other kind carrying
    // a per-kind requirement declares it here, and a kind that skipped it
    // would be discoverable only by being refused.
    //
    // Fails if the rule is dropped, or if the status vocabulary drifts from
    // the one the handler enforces — the assertion is derived from
    // CHECK_RUN_STATUSES, so the contract and the guard cannot disagree
    // about which words are legal.
    const contract = await contractFor("record_artifact");

    const rule = declaredRules(contract).find(
      (entry) => entry.fields.includes("kind") && /check_run/.test(entry.rule),
    );
    expect(rule).toBeDefined();
    // Required, which is the half a caller cannot guess from a nullable field.
    expect(rule!.rule).toMatch(/REQUIRED/);
    for (const status of CHECK_RUN_STATUSES) {
      expect(rule!.rule, status).toContain(status);
    }
    // The kind is reachable at all — a rule describing a kind the enum does
    // not offer would be documentation for something uncallable.
    const kindField = contract.fields.find((entry) => entry.name === "kind");
    expect(kindField?.enumValues).toContain("check_run");
  });

  it("tells a caller that only commitSha is read as evidence and ref is not", async () => {
    // `ref` and `commitSha` both accept a sha and both store it without
    // complaint, but every evidence gate reads `commitSha` alone. A caller
    // who puts the sha in `ref` is refused later by a guard that reports the
    // artifact as naming no commit — which is true, and unguessable from the
    // write surface. This cost a real transition (item 78d144ee) before the
    // rule existed.
    //
    // Asserted through `contractFor`, the same renderer a caller reaches, so
    // this fails if the rule is dropped from RECORD_ARTIFACT_CONTRACT.rules
    // or if the rules array stops being served — not merely if a string
    // vanishes from the source file.
    const contract = await contractFor("record_artifact");

    const rule = declaredRules(contract).find(
      (entry) => entry.fields.includes("ref") && entry.fields.includes("commitSha"),
    );
    expect(rule).toBeDefined();

    // The asymmetry itself, which is the whole point of the rule: a reader
    // who comes away thinking either field will do has learned nothing.
    // Single-character mutation this catches: dropping `"commitSha"` from
    // that rule's `fields` array leaves `rule` undefined and fails above;
    // rewording the text to stop naming the gates fails here.
    expect(rule!.rule).toMatch(/only `?commitSha`?/i);
    for (const gate of [
      "artifact.evidence_at_tip",
      "merge.requires_approving_code_review",
      "merge.requires_authorisation",
    ]) {
      expect(rule!.rule, gate).toContain(gate);
    }

    // Both fields are really on this operation — a rule contrasting a field
    // the caller cannot pass would be documentation for nothing.
    expect(contract.fields.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["ref", "commitSha"]),
    );
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
    const rule = declaredRules(contract).find((entry) => entry.fields.includes("findings"));
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

    const originRule = declaredRules(contract).find((entry) => entry.fields.includes("originType"));
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

  it("omits rules entirely, not an error, for a tool that declares no contract", async () => {
    // `get_item` declares no contract. Answering rather than failing is the
    // behaviour under test, and a caller must be able to tell that apart
    // from a failure — so this asserts it succeeds AND that the rest of the
    // answer is intact, not merely that it did not throw.
    //
    // **The key is ABSENT, not `[]`.** An empty array is what an operation
    // that declares a contract carrying no rules returns, and the two must
    // not render alike — see the distinction test below.
    //
    // Note what this still does NOT assert: an absent key is not a statement
    // that the operation has no preconditions. It says only that none were
    // declared. `get_item` is a read whose schema genuinely says everything;
    // the four operations that reported an empty list while enforcing an
    // assignment check are covered below.
    const contract = await contractFor("get_item");
    expect(contract).not.toHaveProperty("rules");
    expect(contract.rules).toBeUndefined();
    expect(contract.fields.length).toBeGreaterThan(0);
  });

  // ── The distinction itself ────────────────────────────────────────────
  //
  // This is the test the row asked for: it FAILS if the two states collapse
  // back into one. Both halves are needed — asserting only that a
  // no-contract operation omits the key would still pass if EVERY operation
  // omitted it, and asserting only that a contract-declaring one carries it
  // would still pass if every operation carried `[]`.
  //
  // The ambiguity this removes produced wrong documentation twice, and both
  // times the wrong doc got followed: `checkpoint`, `release`, `heartbeat`
  // and `claim` enforced database-backed preconditions while declaring no
  // contract, all four answered `rules: []` to the one question a refused
  // caller asks, three documents were changed to say `checkpoint` needs no
  // claim, and three sessions were refused after following them.
  it("distinguishes declaring no contract from declaring one with no rules", async () => {
    // Half one: no contract at all → the key is absent.
    const noContract = await contractFor("get_item");
    expect(noContract.rules).toBeUndefined();

    // Half two: a declared contract → the key is present. `describe_tool`
    // declares its own, so this needs no fixture operation.
    const declared = await contractFor("describe_tool");
    expect(declared.rules).toBeDefined();
    expect(Array.isArray(declared.rules)).toBe(true);

    // And the two are genuinely different values, which is the property
    // that was missing. A `?? []` in the handler makes this line fail.
    expect(noContract.rules).not.toEqual(declared.rules);
    expect(typeof noContract.rules).not.toBe(typeof declared.rules);
  });

  it("states in its own contract what an absent rules key means", async () => {
    // Criterion: whichever shape is chosen, `describe_tool` says what it
    // means, so the next reader does not have to infer it — the inference
    // that produced the two wrong documents. The caller who needs this is
    // reading the response, not the source file.
    const text = ruleText(await contractFor("describe_tool"));
    expect(text).toContain("ABSENT");
    expect(text).toContain("declares no contract");
    // The standing warning, stated where it fires rather than left to a
    // doc: an empty or absent list is not proof that nothing is enforced.
    expect(text).toMatch(/presence, never of absence/i);
  });
});

// ── repo and headline: enforced but undiscoverable before the call ──────
//
// `create_work` (and the three creates it shares COMMON_CREATE_RULES with)
// refused a real repo name with only "No such repo: X." — naming the input,
// never the valid set. `headline`'s 200-char cap was refused correctly but
// was equally invisible beforehand. Both are now declared rules, and
// `update_item` — which enforces the identical repo check and had NO
// contract at all — gets its first one.
//
// Substance, not presence (#372's standard): a rule that keeps the `repo`
// or `headline` entry but drops the guidance must fail here. An MCP caller
// cannot call `list_repos` (waived off every MCP transport), so the
// reachable-route assertion below checks for `get_board`/`list_items` —
// the routes an MCP caller can actually use — not merely that some prose
// exists.
describe("describe_tool declares create_work's repo and headline rules", () => {
  const CREATE_OPERATIONS = [
    "create_work",
    "create_task",
    "create_project",
    "create_subtask",
  ] as const;

  it.each(CREATE_OPERATIONS)(
    "%s's repo rule names the MCP-reachable route and the archived caveat",
    async (name) => {
      const contract = await contractFor(name);
      const rule = declaredRules(contract).find((entry) => entry.fields.includes("repo"));
      expect(rule).toBeDefined();
      // The reachable route for an MCP caller — list_repos is waived off MCP,
      // so pointing only at it would strand the entire reported population.
      expect(rule!.rule).toContain("get_board");
      expect(rule!.rule).toContain("list_items");
      // The direct enumeration is still named, but marked as non-MCP so the
      // advice-defect checker does not (correctly) flag it as unreachable.
      expect(rule!.rule).toContain("list_repos");
      expect(rule!.rule).toContain("[http/cli]");
      // Pre-registration and the archived caveat are the two facts an MCP
      // caller cannot get any other way.
      expect(rule!.rule.toLowerCase()).toContain("archived");
      expect(rule!.rule).toContain("Repo");
    },
  );

  it.each(CREATE_OPERATIONS)(
    "%s's headline rule states the real cap and that it is optional",
    async (name) => {
      const contract = await contractFor(name);
      const rule = declaredRules(contract).find((entry) => entry.fields.includes("headline"));
      expect(rule).toBeDefined();
      // Interpolated from the constant, per the complete_item precedent above
      // — a cap change and a stale doc are both caught.
      expect(rule!.rule).toContain(String(HEADLINE_MAX_CHARS));
      expect(rule!.rule.toLowerCase()).toContain("optional");
    },
  );

  it("update_item declares its first-ever contract, with the same two rules restated for editing", async () => {
    // Meaningful because an operation declaring zero rules is otherwise
    // indistinguishable from one with none to declare — exactly #372's
    // regression shape, now closed for this operation too.
    const contract = await contractFor("update_item");
    expect(declaredRules(contract).length).toBeGreaterThan(0);

    const repoRule = declaredRules(contract).find((entry) => entry.fields.includes("repo"));
    expect(repoRule).toBeDefined();
    expect(repoRule!.rule).toContain("get_board");
    expect(repoRule!.rule).toContain("list_items");
    expect(repoRule!.rule).toContain("list_repos");
    expect(repoRule!.rule).toContain("[http/cli]");
    expect(repoRule!.rule.toLowerCase()).toContain("archived");
    // update's distinguishing behaviour a create rule does not have: an
    // explicit null clears the field.
    expect(repoRule!.rule).toContain("null");

    const headlineRule = declaredRules(contract).find((entry) => entry.fields.includes("headline"));
    expect(headlineRule).toBeDefined();
    expect(headlineRule!.rule).toContain(String(HEADLINE_MAX_CHARS));
    expect(headlineRule!.rule).toContain("null");
  });
});

// The end-to-end refusal message: proves the same instruction reaches the
// actual thrown error, not only the contract.
//
// Ope's 2026-09-14 decision (closing `80c23a90-1070-4edf-b6c8-0a32209dca44`)
// changed what the *thrown* refusal says: it now names the valid repo ids
// itself, rather than pointing at `get_board`/`list_items` as the only
// MCP-reachable route to them. The contract prose above (the *static*
// per-operation documentation) still names those routes as background — an
// MCP caller has no other way to enumerate `Repo` before ever calling
// `create_work`/`update_item` — but the live refusal is the enumeration now.
//
// Two shapes are exercised per operation: an empty `Repo` table (the inert
// handle every other test in this file uses, and the honest "nothing is
// registered yet" case), and a populated one built with a small fake handle,
// which is also what proves the cap and the near-miss ordering.
describe("the repo refusal message names the valid repo ids, not just the bad input", () => {
  it("create_work's refusal reports 'no repos registered' against an empty table", async () => {
    const error = await refusal("create_work", {
      type: "project",
      title: "probe",
      body: "probe",
      area: "web",
      originType: "auto",
      repo: "definitely-not-a-real-repo-id",
    });
    expect(error.message).toContain("No such repo:");
    expect(error.message).toContain("No repos are registered yet");
    expect(error.message).toContain("create_repo");
    expect(error.message).toContain("[http/cli]");
  });

  it("create_work's refusal lists valid ids, closest match first, when repos exist", async () => {
    const repoIds = ["joda-creative-studio", "fynance", "agent-standup"];
    const fakeHandle: TransactionHandle = {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        // The existence check (`WHERE "id" = $1`) must miss — that is what
        // triggers the refusal in the first place. Only the enumeration
        // query (no `id` filter) sees the fake table.
        if (query.includes('FROM "Repo"') && query.includes('"id" = $1')) return [] as T;
        if (query.includes('FROM "Repo"')) return repoIds.map((id) => ({ id })) as T;
        return [] as T;
      },
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
    const fakeRuntime = new ServiceRuntime({
      transaction: (body) => body(fakeHandle),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    let error: NotFoundError | undefined;
    try {
      await fakeRuntime.call("create_work", {
        type: "project",
        title: "probe",
        body: "probe",
        area: "web",
        originType: "auto",
        // A case/punctuation slip on the real "joda-creative-studio" id —
        // the near-miss case straight from the reported bug.
        repo: "Joda-creative-studio",
      });
    } catch (caught) {
      if (isServiceError(caught)) error = caught as NotFoundError;
      else throw caught;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("No such repo: Joda-creative-studio");
    // Closest match (one substitution away) leads the list.
    const idx = (needle: string) => error!.message.indexOf(needle);
    expect(idx("joda-creative-studio")).toBeGreaterThan(-1);
    expect(idx("joda-creative-studio")).toBeLessThan(idx("fynance"));
    expect(idx("joda-creative-studio")).toBeLessThan(idx("agent-standup"));
  });

  it("caps a long repo list and states how many more there are", async () => {
    const repoIds = Array.from({ length: 15 }, (_, i) => `repo-${String(i).padStart(2, "0")}`);
    const fakeHandle: TransactionHandle = {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes('FROM "Repo"') && query.includes('"id" = $1')) return [] as T;
        if (query.includes('FROM "Repo"')) return repoIds.map((id) => ({ id })) as T;
        return [] as T;
      },
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
    const fakeRuntime = new ServiceRuntime({
      transaction: (body) => body(fakeHandle),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    let error: NotFoundError | undefined;
    try {
      await fakeRuntime.call("create_work", {
        type: "project",
        title: "probe",
        body: "probe",
        area: "web",
        originType: "auto",
        repo: "not-a-real-repo",
      });
    } catch (caught) {
      if (isServiceError(caught)) error = caught as NotFoundError;
      else throw caught;
    }
    expect(error).toBeDefined();
    // 15 repos, capped at 10 (no-such-repo.ts's MAX_LISTED_REPOS) leaves 5 more.
    expect(error!.message).toContain("and 5 more");
    // Not a dump of all 15 ids.
    expect(error!.message).not.toContain("repo-14");
  });

  it("update_item's refusal carries the identical enumeration, not the static route wording", async () => {
    // No real database: a small fake handle answers the one `Item` lookup
    // `update_item` makes before it ever reaches the repo check, and the
    // one `Repo` lookup that builds the valid-set list, so the repo-refusal
    // branch is reached without a Postgres instance.
    const fakeItemRow = {
      id: "11111111-1111-1111-1111-111111111111",
      parentId: null,
      kind: "task",
      depth: 1,
      title: "probe",
      headline: null,
      body: "probe",
      state: "in_progress",
      priority: "P2",
      originType: "auto",
      originPersonId: null,
      area: "web",
      areas: ["web"],
      repo: null,
      branch: null,
      needsVisualReview: false,
      driveMode: "autonomous",
      mergeAuthority: "pre_approved",
      customFields: null,
    };
    const repoIds = ["joda-creative-studio", "fynance"];
    const fakeHandle: TransactionHandle = {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes('FROM "Repo"') && query.includes('"id" = $1')) return [] as T;
        if (query.includes('FROM "Repo"')) return repoIds.map((id) => ({ id })) as T;
        if (query.includes('FROM "Item"')) return [fakeItemRow] as T;
        return [] as T;
      },
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
    const fakeRuntime = new ServiceRuntime({
      transaction: (body) => body(fakeHandle),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    let error: NotFoundError | undefined;
    try {
      await fakeRuntime.call("update_item", {
        id: fakeItemRow.id,
        repo: "definitely-not-a-real-repo-id",
      });
    } catch (caught) {
      if (isServiceError(caught)) error = caught as NotFoundError;
      else throw caught;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("No such repo:");
    expect(error!.message).toContain("joda-creative-studio");
    expect(error!.message).toContain("fynance");
  });
});

// ── The rules that were enforced and undeclared ───────────────────────
//
// The regression these exist for is not a crash. `checkpoint`, `release`,
// `heartbeat` and `claim` each refuse callers on a check the database
// performs, and each reported `rules: []` — which read as "no preconditions"
// and was acted on as such: three documents were corrected to say
// `checkpoint` needs no claim, and three sessions were refused on the
// strength of them.
//
// So these assert the SUBSTANCE of each rule, not its presence. A test that
// asserted `rules.length > 0` would pass against a contract declaring
// anything at all — including a rule about something else entirely — and
// would therefore not have caught the thing that happened. Each case below
// names the field pairing and the words a caller needs to find in it, so
// deleting a rule fails, and so does gutting its guidance while keeping the
// entry.
describe("describe_tool declares the assignment rules its callers were refused by", () => {
  /** The three operations that make one assignment lookup for one reason. */
  const ASSIGNMENT_OPERATIONS = ["checkpoint", "release", "heartbeat"] as const;

  it.each(ASSIGNMENT_OPERATIONS)(
    "%s declares that it needs the caller's own live assignment",
    async (name) => {
      const contract = await contractFor(name);

      // Matched on the field pairing the refusal itself carries —
      // `fields: ["itemId", "sessionId"]` — which is what `OperationRule.fields`
      // is for: a caller holding a refusal can find the rule that refused it
      // without matching on prose.
      const rule = declaredRules(contract).find(
        (entry) => entry.fields.includes("sessionId") && entry.fields.includes("itemId"),
      );
      expect(rule, `${name} declares no rule about itemId + sessionId`).toBeDefined();

      // The substance. "Live assignment" is the condition, `releasedAt` is
      // the column that decides it, and a rule stating the requirement
      // without naming the way out leaves a refused caller exactly where it
      // started — which is the failure this row is about.
      expect(rule!.rule).toContain("live assignment");
      expect(rule!.rule).toContain("releasedAt");
      expect(rule!.rule).toContain("claim");
      expect(rule!.rule).toContain("note");
    },
  );

  it("checkpoint's rule says note is the alternative that needs no assignment", async () => {
    // The exact sentence whose absence caused the incident. A dispatched
    // agent that has not claimed has two correct moves — claim, or use
    // `note` — and the documentation written instead told it to checkpoint
    // regardless.
    const text = ruleText(await contractFor("checkpoint"));
    expect(text).toContain("needs no assignment");
    // The negative that matters: nothing in checkpoint's own contract may
    // suggest the assignment is optional.
    expect(text).not.toMatch(/no claim (is )?(needed|required)/i);
  });

  it("checkpoint declares that it records per agent, not merely per item", async () => {
    // SCHEMA.md §4's reason for the requirement. Without it the rule reads as
    // an arbitrary gate rather than as the thing giving each agent its own
    // resume point, and an arbitrary-looking gate is the kind that gets
    // documented away.
    expect(ruleText(await contractFor("checkpoint"))).toContain("PER AGENT");
  });

  it("heartbeat declares that it appends no event", async () => {
    // A caller looking for its heartbeat in the item history will not find
    // one, and no schema can say so.
    expect(ruleText(await contractFor("heartbeat"))).toContain("NO event");
  });

  it("release points at takeover for somebody else's claim", async () => {
    expect(ruleText(await contractFor("release"))).toContain("takeover");
  });
});

describe("describe_tool declares claim's crew and uniqueness rules", () => {
  it("says rootSessionId defaults to the caller's own sessionId", async () => {
    // The defect that refused a dispatched agent sent to help: omitting
    // `rootSessionId` does not mean "unknown", it means "I am my own crew",
    // and the schema's `.optional()` reads as the opposite. A dispatched
    // agent must pass the ORCHESTRATOR's session id.
    const contract = await contractFor("claim");
    const rule = declaredRules(contract).find((entry) => entry.fields.includes("rootSessionId"));
    expect(rule, "claim declares no rule about rootSessionId").toBeDefined();
    expect(rule!.rule).toContain("defaults");
    expect(rule!.rule).toContain("sessionId");
    // Naming the dispatched case specifically, since that is the caller who
    // gets this wrong and the one an empty contract stranded.
    expect(rule!.rule.toLowerCase()).toContain("dispatched");
  });

  it("declares both uniqueness rules, which are indexes rather than input checks", async () => {
    const text = ruleText(await contractFor("claim"));
    // One live row per session per item, and one live orchestrator per item
    // — both real, both refusing callers, neither expressible in a schema.
    expect(text).toContain("ONE LIVE ROW PER SESSION PER ITEM");
    expect(text).toContain("ONE LIVE ORCHESTRATOR PER ITEM");
  });

  it("declares that an unregistered session cannot omit machine", async () => {
    const contract = await contractFor("claim");
    const rule = declaredRules(contract).find((entry) => entry.fields.includes("machine"));
    expect(rule, "claim declares no rule about machine").toBeDefined();
    expect(rule!.rule).toContain("register_session");
  });

  it("declares the role/roleCustom pairing in both directions", async () => {
    const contract = await contractFor("claim");
    const rule = declaredRules(contract).find((entry) => entry.fields.includes("roleCustom"));
    expect(rule).toBeDefined();
    expect(rule!.rule).toContain("required");
    // The quieter half: a name beside a real role is refused, not ignored.
    expect(rule!.rule).toContain("refused");
  });
});

describe("an operation that reads the database to refuse declares that it does", () => {
  // The generalisation of the incident, as a standing check rather than four
  // named cases. `describe_tool` cannot detect an undeclared rule — that is
  // its structural limit — so the guard against the next one has to be a
  // test that knows which operations perform an assignment lookup.
  //
  // This list is deliberately hand-maintained and deliberately short: it is
  // the set whose refusals were being misread as "no preconditions". Adding
  // an operation to it without declaring that operation's rule fails, which
  // is the point.
  const ASSIGNMENT_GATED = ["checkpoint", "release", "heartbeat", "claim"] as const;

  it.each(ASSIGNMENT_GATED)("%s does not report an empty rules list", async (name) => {
    const contract = await contractFor(name);
    expect(
      contract.rules,
      `${name} refuses callers on a database check; an empty contract tells them the opposite`,
    ).not.toEqual([]);
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

// The headline-overage refusal a source note praised by name: "the message
// is genuinely GOOD; the problem is purely that the cap is invisible
// beforehand." So this pins the composed refusal a caller actually reads,
// not a hand-authored string — there is no custom message anywhere in the
// source (`headline` is a bare `z.string().trim().min(1).max(HEADLINE_MAX_CHARS)`
// with no `.refine()` message), the text is composed at call time from
// zod's own overage wording plus shape-refusal.ts's routing suffix. Pinning
// the interpolated cap, not the literal 200, means a cap change is caught
// rather than the test silently drifting out of sync with it. Pure zod +
// shapeRefusalMessage, no database in the path — runs locally.
describe("the praised headline-overage refusal is unchanged by this item's edits", () => {
  it("create_work still emits zod's overage wording plus the describe_tool routing suffix", async () => {
    const error = await refusal("create_work", {
      type: "project",
      title: "probe",
      body: "probe",
      area: "web",
      originType: "auto",
      headline: "x".repeat(HEADLINE_MAX_CHARS + 1),
    });
    expect(error.message).toContain(`at most ${HEADLINE_MAX_CHARS} character(s)`);
    expect(error.message).toContain(
      "for the full contract, including the rules the schema cannot state.",
    );
  });

  it("update_item's headline-overage refusal carries the identical two fragments", async () => {
    const fakeItemRow = {
      id: "22222222-2222-2222-2222-222222222222",
      parentId: null,
      kind: "task",
      depth: 1,
      title: "probe",
      headline: null,
      body: "probe",
      state: "in_progress",
      priority: "P2",
      originType: "auto",
      originPersonId: null,
      area: "web",
      areas: ["web"],
      repo: null,
      branch: null,
      needsVisualReview: false,
      driveMode: "autonomous",
      mergeAuthority: "pre_approved",
      customFields: null,
    };
    const fakeHandle: TransactionHandle = {
      $queryRawUnsafe: async <T = unknown>(): Promise<T> => [fakeItemRow] as T,
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
    const fakeRuntime = new ServiceRuntime({
      transaction: (body) => body(fakeHandle),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    let error: InvalidInputError | undefined;
    try {
      await fakeRuntime.call("update_item", {
        id: fakeItemRow.id,
        headline: "x".repeat(HEADLINE_MAX_CHARS + 1),
      });
    } catch (caught) {
      if (isServiceError(caught)) error = caught as InvalidInputError;
      else throw caught;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain(`at most ${HEADLINE_MAX_CHARS} character(s)`);
    expect(error!.message).toContain(
      "for the full contract, including the rules the schema cannot state.",
    );
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
      // `?? []` and not `declaredRules` here: this sweep walks EVERY
      // operation, and most legitimately declare no contract at all, which
      // now omits the key. Absence is the expected answer for them, so this
      // loop skips them rather than failing them — what it exists to catch
      // is a DECLARED rule naming a field the schema does not have.
      for (const rule of contract.rules ?? []) {
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
      // Same reason as the sweep above: an operation declaring no contract
      // omits `rules`, and that is correct rather than a defect.
      for (const rule of contract.rules ?? []) {
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

describe("describe_tool declares the transport-retry rule on itself", () => {
  // The layer below #390's `retryable`/`committed` on MCP write FAILURES —
  // this is about the call that never landed at all. "Unable to connect" is
  // raised by the MCP client before a request reaches this server, so no
  // response can ever carry a flag for it; the only honest place to answer
  // "is this worth retrying" is a rule read on a PRIOR successful call.
  // `describe_tool` is that surface, so it documents this about itself.
  it("says retry once, then stop and report", async () => {
    const text = ruleText(await contractFor("describe_tool"));
    expect(text).toContain("Unable to connect");
    expect(text).toContain("ONCE");
    expect(text).toContain("stop and report");
  });

  it("defers to committed for writes, so a blanket retry cannot double-write", async () => {
    // Inherited from #390 (errors.ts: "`committed` outranks `retryable`,
    // always"), not invented here. Without this clause, "retry once" against
    // an append-only store with no dedupe (note, checkpoint) double-writes.
    const text = ruleText(await contractFor("describe_tool"));
    expect(text).toContain("committed");
    expect(text).toContain("retryable");
    expect(text.toLowerCase()).toContain("append-only");
  });

  it("does not report an empty rules list", async () => {
    const contract = await contractFor("describe_tool");
    expect(contract.rules).not.toEqual([]);
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
    const rule = declaredRules(contract).find((entry) =>
      entry.fields.includes("summary.what_to_test"),
    );
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
    const rule = declaredRules(contract).find((entry) =>
      entry.fields.includes("summary.watch_for"),
    );
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
    const whatToTest = declaredRules(contract).find((e) =>
      e.fields.includes("summary.what_to_test"),
    )!;
    const watchFor = declaredRules(contract).find((e) => e.fields.includes("summary.watch_for"))!;
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

describe("describe_tool reports the transport it was called on", () => {
  /** Calls describe_tool with no `tool`, over the given transport (or none). */
  async function factsOn(transport?: string): Promise<ServiceFacts> {
    const rt = new ServiceRuntime({
      transaction: (body) => body(inertHandle),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    return (await rt.call(
      "describe_tool",
      {},
      transport ? { caller: { transport } } : undefined,
    )) as ServiceFacts;
  }

  it("names the mcp_stdio adapter and its transport, on that transport", async () => {
    const answer = await factsOn("mcp-stdio");
    expect(answer.transport.transport).toBe("mcp-stdio");
    expect(answer.transport.adapter).toBe("mcp_stdio");
  });

  it("names the mcp_http adapter and its transport, on that transport", async () => {
    const answer = await factsOn("mcp-http");
    expect(answer.transport.transport).toBe("mcp-http");
    expect(answer.transport.adapter).toBe("mcp_http");
  });

  it("reports no adapter for a non-MCP transport — HTTP and the CLI carry no adapter waivers", async () => {
    const answer = await factsOn("http");
    expect(answer.transport.transport).toBe("http");
    expect(answer.transport.adapter).toBeNull();
    expect(answer.transport.waived).toBeNull();
  });

  it("reports both fields null when the call carried no transport at all", async () => {
    const answer = await factsOn(undefined);
    expect(answer.transport.transport).toBeNull();
    expect(answer.transport.adapter).toBeNull();
  });

  it("lists this adapter's waived operations with their reasons, on mcp_stdio", async () => {
    const answer = await factsOn("mcp-stdio");
    expect(answer.transport.waived).not.toBeNull();
    const waived = answer.transport.waived ?? [];
    expect(waived.length).toBeGreaterThan(0);
    // backfill is waived on both MCP adapters (adapters/waivers.ts) — a
    // concrete member proves this is the real waiver list, not an empty
    // array that would pass "not toBeNull" vacuously.
    const backfill = waived.find((entry) => entry.operation === "backfill");
    expect(backfill).toBeDefined();
    expect(backfill?.reason.length).toBeGreaterThan(0);
  });

  it("says poll is waived on mcp_stdio too, so the surface does not imply a difference that is not there", async () => {
    // The item's own scope note: poll is already waived on BOTH MCP
    // transports, and the reporting should make that discoverable rather
    // than implying stdio lost something http has.
    const stdio = await factsOn("mcp-stdio");
    const http = await factsOn("mcp-http");
    const stdioHasPoll = (stdio.transport.waived ?? []).some((entry) => entry.operation === "poll");
    const httpHasPoll = (http.transport.waived ?? []).some((entry) => entry.operation === "poll");
    expect(stdioHasPoll).toBe(true);
    expect(httpHasPoll).toBe(true);
  });
});

describe("describe_tool reports migration drift", () => {
  /** A transaction handle whose `_prisma_migrations` query answers with the given applied migration names. */
  function handleWithAppliedMigrations(names: readonly string[]): TransactionHandle {
    return {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("_prisma_migrations")) {
          return names.map((name) => ({ name })) as T;
        }
        return [] as T;
      },
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
  }

  async function factsWithAppliedMigrations(names: readonly string[]): Promise<ServiceFacts> {
    const rt = new ServiceRuntime({
      transaction: (body) => body(handleWithAppliedMigrations(names)),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    return (await rt.call("describe_tool", {})) as ServiceFacts;
  }

  it("reports no drift when the database has applied nothing yet", async () => {
    const answer = await factsWithAppliedMigrations([]);
    expect(answer.migrations.severity).toBe("none");
  });

  it("reports database_ahead when the database has applied a migration this checkout does not ship", async () => {
    // The real `prisma/migrations` directory backs this test (no filesystem
    // fake here — `defaultMigrationsDir()` resolves against the real repo
    // checkout tests run from), so any name that plausibly postdates every
    // real migration folder proves the comparison reads live migration
    // names, not a fixture.
    const answer = await factsWithAppliedMigrations(["99999999999999_a_migration_from_the_future"]);
    expect(answer.migrations.severity).toBe("incompatible");
    // Whether this checkout's oldest recognised migration is older than the
    // database's only applied one — which it always is here, since the
    // fabricated name sorts after every real one, making it the *oldest and
    // newest* applied migration at once, and therefore unrecognised — is
    // exactly the incompatible case, not merely "ahead". Asserted via the
    // severity rather than re-deriving the sort, which `state.test.ts`
    // already covers exhaustively; this test's job is only to prove
    // describe_tool wires the real filesystem read through.
    expect(answer.migrations.databaseNewest).toBe("99999999999999_a_migration_from_the_future");
  });

  it("carries the message a startup warning would print verbatim", async () => {
    const answer = await factsWithAppliedMigrations(["99999999999999_a_migration_from_the_future"]);
    expect(typeof answer.migrations.message).toBe("string");
    expect(answer.migrations.message.length).toBeGreaterThan(0);
  });
});

/** Silences the unused-import lint for a type used only in annotations above. */
export type _Ctx = ServiceContext;

describe("a required array<object> is constructable from its own contract", () => {
  // Row 227013f0, from the 2026-09-12 note. `describe_tool` is the one read
  // whose subject is the contract rather than the data, and it renders a
  // nested parameter as the bare type `array<object>` — correctly, since
  // `fields.ts` refuses to reimplement JSON Schema. That only works while
  // the element shape is documented in `contract.rules`, and for these
  // three operations it was not documented at all.
  //
  // `score_run.scores` is the one the note's author was actually blocked
  // on: REQUIRED, `array<object>`, and `rules: []`. Unconstructable from
  // the tool whose entire job is to describe it.

  it("gives score_run.scores its facets, its range and a worked example", async () => {
    const contract = await contractFor("score_run");

    const field = contract.fields.find((entry) => entry.name === "scores");
    expect(field).toBeDefined();
    // The container's type is unchanged and deliberately so — this row
    // documents the element rather than expanding the rendering.
    expect(field!.type).toBe("array<object>");
    expect(field!.required).toBe(true);

    const rule = declaredRules(contract).find((entry) => entry.fields.includes("scores"));
    expect(rule).toBeDefined();

    const text = ruleText(contract);
    // Both element keys are named. Single-character mutation this catches:
    // renaming `facet` in score-run.ts's facetScoreSchema.
    expect(text).toContain("facet");
    expect(text).toContain("score");
    // The vocabulary is interpolated from FACETS and the range constants
    // rather than retyped, so the documented set cannot drift from the
    // enforced one.
    for (const facet of FACETS) {
      expect(text).toContain(facet);
    }
    expect(text).toContain(String(MIN_RUN_SCORE));
    expect(text).toContain(String(MAX_RUN_SCORE));

    // A worked example that the operation's own schema accepts. An example
    // the validator would refuse is worse than none.
    const example = contract.example as Record<string, unknown> | undefined;
    expect(example).toBeDefined();
    expect(Array.isArray(example!.scores)).toBe(true);
    expect(OPERATION_REGISTRY.score_run.input.safeParse(example).success).toBe(true);
  });

  it("gives record_intervention.captures its required keys and outcomes", async () => {
    const contract = await contractFor("record_intervention");

    const field = contract.fields.find((entry) => entry.name === "captures");
    expect(field!.type).toBe("array<object>");
    expect(field!.required).toBe(true);
    expect(declaredRules(contract).some((entry) => entry.fields.includes("captures"))).toBe(true);

    const text = ruleText(contract);
    expect(text).toContain("entryId");
    expect(text).toContain("outcome");
    for (const outcome of INTERVENTION_OUTCOMES) {
      expect(text).toContain(outcome);
    }

    const example = contract.example as Record<string, unknown> | undefined;
    expect(example).toBeDefined();
    expect(OPERATION_REGISTRY.record_intervention.input.safeParse(example).success).toBe(true);
  });

  it("gives record_tool_calls.calls its required keys and a worked example", async () => {
    const contract = await contractFor("record_tool_calls");

    const field = contract.fields.find((entry) => entry.name === "calls");
    expect(field!.type).toBe("array<object>");
    expect(field!.required).toBe(true);
    expect(declaredRules(contract).some((entry) => entry.fields.includes("calls"))).toBe(true);

    // `tool` and `ts` are the only two required keys, and `ts` carries the
    // rule a caller gets wrong silently: the time of the CALL, not of the
    // flush.
    const text = ruleText(contract);
    expect(text).toContain("tool");
    expect(text).toContain("ts");

    const example = contract.example as Record<string, unknown> | undefined;
    expect(example).toBeDefined();
    expect(OPERATION_REGISTRY.record_tool_calls.input.safeParse(example).success).toBe(true);
  });
});
