// The gate against an intervention nothing can ever fire, and against the
// service-delivery channel losing its producer again — MILESTONES.md #128.
//
// ── Why this file exists, from the record rather than from principle ────
//
// This repository has built the same defect three times and named it twice.
// `src/lib/interventions/stop-context.ts`'s own header records that the stop
// catch **"was built, is correct, and has never once spoken"**. The service
// delivery seam was the second instance, in the precise half-wired form that
// makes this class hard to spot: `decideDelivery` was called with no
// `findings` key, so the payload's **immediate** member had no producer at
// all, while its **digest** member kept working because `take()` is called
// unconditionally and the hook route fills the accumulator via `hold()`. A
// session could be handed things noticed five minutes ago and never be told
// anything about the call in its hand.
// `builtins.ts` names the third: `visual-reviews-in-flight-concurrently`
// shipped with **no assembler at all**, its predicate reading a field nothing
// in the codebase ever wrote.
//
// `builtins.ts` also states the rule its own entry broke: *"a registry entry
// that cannot trigger is worse than an absent one: it reads as coverage on
// the settings page and provides none."* The rule was right and unenforced.
//
// The distinguishing feature of this defect class is that **the ordinary
// tests pass**, because each end is individually correct. A per-file review
// does not catch it either, because the gap is *between* files. So it is a
// gate, for the same reason `scripts/check-event-emitters.mjs` is a gate:
// nobody argues the rule is wrong, the producer is simply left for a
// follow-up nobody files.
//
// ── Why it lives here rather than in `scripts/` ─────────────────────────
//
// It decides reachability **by running each predicate**, so it needs the real
// module graph — `builtins.ts` imports `./commands` extensionless and through
// the `@/` alias, which a bare `node scripts/*.mjs` cannot resolve. Running
// it under vitest means the predicates exercised here are exactly the objects
// the registry evaluates in production, with no parallel copy to drift.
//
// ── How reachability is decided: BY EXECUTION, NOT BY GREP ──────────────
//
// This is the load-bearing half, and it is the lesson
// `check-event-emitters.mjs` learned the hard way: its first version counted
// a `type:` property wherever it appeared, so a *read* path naming a value
// made it look written, and the gate went green on the precise defect it was
// built for. A grep-based version of this test would pass on
// `visual-reviews-in-flight-concurrently`, whose predicate reads
// `context.pendingVisualReviews` — a field declared in `types.ts`,
// documented at length, and written by nothing.
//
// So nothing here matches on a field name. Each predicate is *called*, with a
// context narrowed to what one producer can actually assemble, and asked
// whether it returns `triggered: true`.
//
// ── What a green run does NOT mean ──────────────────────────────────────
//
// Stated as plainly as the sibling check states its own limits:
//
//   - It proves a predicate **can** fire, not that a real board ever reaches
//     that state.
//   - It does not check the message, the level or the timing.
//   - **It does not prove delivery.** The wiring assertions below check the
//     shapes whose absence broke the channel; they cannot prove a finding
//     reached a caller. Only observing one does that, which is why the item
//     this closes asks for an observation and says a passing test is
//     specifically not evidence.
//
// Every failure mode makes this stricter, never laxer: a predicate the
// harness cannot make fire reports as unreachable, which fails loudly and
// someone fixes. There is deliberately no shape that makes an unreachable
// entry look reachable, because reachability is decided by running the thing
// rather than by reading about it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import type { Intervention, InterventionContext } from "@/lib/interventions/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/**
 * Strips comments before a wiring shape is matched against source.
 *
 * **Not fastidiousness — a hole this file actually had.** The first version
 * of the `live.ts` assertion matched `produceInterventions\s*:` against the
 * raw text, and commenting the wiring out left it green while the channel was
 * dead again. Mutation testing caught it; without this the gate would have
 * been the very thing it exists to prevent — a test that reads as coverage
 * and provides none.
 *
 * Deliberately crude: it removes line comments and block comments, which is
 * all these three assertions need. It is not a parser and does not try to be
 * — a string containing `//` would be mangled, and none of the shapes matched
 * here live in strings.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The context fields each producer can assemble.
 *
 * `null` means "everything" — the hook has a command and a tool, so every
 * entry is in principle reachable from it. The service list is the narrow one
 * and it is the whole point: a service call carries **no command and no
 * tool**, so every command-shaped entry correctly declines on that path and
 * only the item-state entries remain.
 *
 * Kept in step with `assembleServiceContext` by the test below, which fails
 * if this list names a field that assembler does not write.
 */
const SERVICE_FIELDS: readonly (keyof InterventionContext)[] = [
  "sessionId",
  "holdsClaim",
  "claimedRole",
  "itemId",
  "itemState",
  "isLinkedWorktree",
  "defaultBranch",
  "deliveryStage",
  "pullRequestAgeSeconds",
  "untrackedNits",
  "pendingVisualReviews",
  "visualReviewDeferredUnrecorded",
  "hasApprovalAtTip",
  "crewInFlight",
];

/**
 * Situations that ought to trigger something, one per shape the catalogue
 * detects.
 *
 * Deliberately *real* situations — a stalled delivery, an item waiting on a
 * review nobody started, untracked nits — rather than arbitrary field values,
 * because the question being asked is whether a situation that actually
 * happens can reach the entry that describes it.
 */
const SITUATIONS: readonly InterventionContext[] = [
  // Item-state situations: reachable from either producer.
  { itemState: "in_review", hasApprovalAtTip: false, itemId: "i1" },
  { deliveryStage: "committed", itemId: "i1" },
  { deliveryStage: "pull_request_open", pullRequestAgeSeconds: 100_000, itemId: "i1" },
  { untrackedNits: { findingCount: 3, reviewRound: 1 }, itemId: "i1" },
  { pendingVisualReviews: 4 },
  { visualReviewDeferredUnrecorded: true, itemId: "i1" },
  // `crewInFlight` must be at least 1: zero is a real answer meaning
  // "nobody is running, you are free to stop", which the entry correctly
  // declines to nudge about. The first draft of this list used 0 and the
  // entry reported as unreachable — the harness working, on the harness.
  { crewInFlight: 3, itemId: "i1", claimedRole: "orchestrator" },
  { handsOnWork: "elevated", claimedRole: "orchestrator", itemId: "i1" },
  { itemState: "in_review", hasApprovalAtTip: false, claimedRole: "reviewer", itemId: "i1" },
  // Command- and tool-shaped situations: the hook alone.
  {
    command: "git add -A",
    isLinkedWorktree: false,
    claimedWorktree: "/tmp/x",
    itemId: "i1",
    occupyingCrew: { rootSessionId: "other", itemId: "i2" },
  },
  { command: "pkill -f node" },
  { command: "git merge main", hasApprovalAtTip: false, hasAnyApproval: false, itemId: "i1" },
  { command: "git merge main", hasApprovalAtTip: false, hasAnyApproval: true, itemId: "i1" },
  { command: "git commit -m x", holdsClaim: false },
  { command: "git log --oneline origin/main..HEAD", itemId: "i1" },
  { command: "git rebase main", itemId: "i1" },
  { command: "git commit --no-gpg-sign -m x", itemId: "i1" },
  { command: "grep -r foo /", itemId: "i1" },
  { tool: "AskUserQuestion", isAskingUser: true },
  {
    tool: "Task",
    unresolvedToolBlocks: [{ tool: "browser_claim", reason: "not_granted" }],
    itemId: "i1",
  },
  {
    tool: "Task",
    concurrentCrewItems: 5,
    crewTerritory: { sharedTrees: [], unrecordedWorktrees: 3 },
    itemId: "i1",
  },
  {
    tool: "Write",
    occupyingCrew: { rootSessionId: "other", itemId: "i2", lastActiveSecondsAgo: 60 },
    itemId: "i1",
    claimedWorktree: "/tmp/x",
  },
];

/**
 * Narrows a situation to what one producer can assemble.
 *
 * This is where a service-unreachable entry becomes visibly unreachable: a
 * predicate reading `command` is handed `undefined` for it, whatever the
 * situation said, and declines exactly as it does in production.
 */
function narrow(
  context: InterventionContext,
  fields: readonly (keyof InterventionContext)[] | null,
): InterventionContext {
  if (fields === null) return context;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (context[key] !== undefined) out[key] = context[key];
  }
  return out as InterventionContext;
}

/** Whether any situation makes this entry fire, under one producer's fields. */
async function canFire(
  entry: Intervention,
  fields: readonly (keyof InterventionContext)[] | null,
): Promise<boolean> {
  for (const situation of SITUATIONS) {
    let verdict;
    try {
      verdict = await entry.predicate(narrow(situation, fields));
    } catch {
      // A predicate that throws did not trigger — the same reading
      // `evaluate` takes. It stays unreachable via this situation.
      continue;
    }
    if (verdict?.triggered === true) return true;
  }
  return false;
}

describe("every declared intervention can actually be fired by some producer", () => {
  // The headline assertion. An entry reachable from neither producer is the
  // `visual-reviews-in-flight-concurrently` situation: declared,
  // configurable, visible on the settings page, and incapable of firing.
  it.each(BUILTIN_INTERVENTIONS.map((entry) => [entry.id, entry] as const))(
    "%s is reachable from at least one producer",
    async (_id, entry) => {
      const hook = await canFire(entry, null);
      const service = await canFire(entry, SERVICE_FIELDS);
      expect(hook || service).toBe(true);
    },
  );
});

describe("the service-delivery channel has a producer", () => {
  // The eight entries the service path carries. Named individually rather
  // than counted, because a count passes when one entry silently swaps for
  // another — and the whole failure this guards against is an entry going
  // quiet without anybody noticing which.
  //
  // Each of these reads item or board state and touches neither `command`
  // nor `tool`, which is what makes it answerable on a call that has
  // neither.
  //
  // **Two of these are here because this test found them, not because they
  // were designed in.** The hand analysis that produced the producer listed
  // six and missed `review-without-approval-at-tip` — which reads exactly
  // the same three fields as `finished-with-no-reviewer`, and was overlooked
  // because its name reads as a review-time check rather than an item-state
  // one — and `crew-in-flight-without-check-in`, whose `crewInFlight` the
  // assembler writes for an orchestrator-held claim. That is the value of
  // deciding reachability by execution: a list written by reading is a list
  // with omissions in it, and both omissions would have been entries that
  // silently never fired on this path.
  const EXPECTED_SERVICE_ENTRIES = [
    "finished-with-no-reviewer",
    "review-without-approval-at-tip",
    "committed-with-no-pull-request",
    "pull-request-with-no-review-requested",
    "nits-merged-with-nothing-tracking-them",
    "visual-reviews-in-flight-concurrently",
    "visual-review-deferred-without-record",
    "crew-in-flight-without-check-in",
  ];

  it("carries exactly the entries a call with no command and no tool can answer", async () => {
    const reachable: string[] = [];
    for (const entry of BUILTIN_INTERVENTIONS) {
      if (await canFire(entry, SERVICE_FIELDS)) reachable.push(entry.id);
    }
    expect(reachable.sort()).toEqual([...EXPECTED_SERVICE_ENTRIES].sort());
  });

  // ── The three wiring shapes whose absence made the channel inert ──────
  //
  // Asserted against the SOURCE of the files that serve real callers, not
  // against a runtime this test constructs. A harness that built its own
  // runtime would pass while `live.ts` — the only runtime real callers reach
  // — was wired differently, which is precisely the between-layers gap this
  // whole file exists to close.
  //
  // Each of these reverting alone silently restores the original defect, and
  // none of them would fail any other test in the suite.

  it("passes `findings` to decideDelivery, the key the immediate half needs", () => {
    const source = withoutComments(read("src/lib/interventions/service-delivery.ts"));
    // `decideDelivery` reads `options.findings ?? []`. Called without the
    // key it partitions an empty list, so nothing can ever appear under
    // `findings` — the payload member defined as "what this very call
    // triggered, delivered now". The digest member is unaffected either
    // way, which is exactly why the gap survived: the channel looked live
    // because half of it was.
    expect(source).toMatch(/decideDelivery\s*\(\s*accumulator\s*,\s*\{[^}]*\bfindings\b/s);
  });

  it("wires a producer beside the deliverer in the live runtime", () => {
    // Read with comments stripped, which is not fastidiousness — it is a
    // hole this test actually had. The first version matched
    // `/produceInterventions\s*:/` against the raw source, and commenting
    // the wiring out (`// produceInterventions: produceServiceFindings,`)
    // left the test green while the channel was dead again. A gate against
    // an absence must not be satisfiable by a line that does nothing.
    const source = withoutComments(read("src/lib/service/live.ts"));
    // The deliverer was wired here alone for weeks. A deliverer with no
    // producer drains an empty tank; a producer with no deliverer finds
    // things and drops them. Neither alone is a useful configuration.
    expect(source).toMatch(/deliverInterventions\s*:/);
    expect(source).toMatch(/produceInterventions\s*:/);
  });

  it("runs the producer with a transaction handle", () => {
    const source = withoutComments(read("src/lib/service/runtime.ts"));
    // Every entry on this path needs item state, and only a handle answers
    // that. The deliverer deliberately has none — so a producer that
    // stopped receiving one would return nothing, for every entry, forever,
    // while still looking wired from both ends.
    expect(source).toMatch(/#produceInterventions\s*\(\s*db\s*,/);
  });

  it("names every field SERVICE_FIELDS claims, in the assembler that writes them", () => {
    // Keeps the narrowing list honest. If `assembleServiceContext` stops
    // writing a field, the list above would still claim it and an entry
    // depending on it would look reachable when it is not — the exact
    // false-green this file exists to prevent.
    const source = withoutComments(read("src/lib/interventions/context.ts"));
    const assembler = source.slice(source.indexOf("export async function assembleServiceContext"));
    const body = assembler.slice(0, assembler.indexOf("\nconst TOOL_BLOCK_LIMIT"));
    // The four item-state fields are written by helpers the assembler
    // spreads, so the helper call is the evidence rather than the field name.
    for (const helper of [
      "deliveryFor",
      "untrackedNitsFor",
      "pendingVisualReviewsFor",
      "deferredVisualReviewFor",
      "currentTipCommitSha",
      "hasApprovingArtifactAtCurrentRoundAndTip",
    ]) {
      expect(body).toContain(helper);
    }
  });
});
