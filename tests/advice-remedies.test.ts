// The sweep for remedies a caller cannot follow.
//
// **The defect class, and why it earns a whole file.** Five times in one
// month this repository shipped a message naming a remedy that did not
// exist: `my_work` advising "a smaller `limit`" while accepting only a
// `sessionId`; `record_artifact.findings` claiming a shape defect that was
// really a bad message, which cost two filed feedback notes chasing a bug
// that was not there; a merge gate advertising a written reason that
// `fields` discarded (#243); a draft telling callers to send
// `mergeAuthority: "pre_approved"` when `update_item` accepts the
// hyphenated `pre-approved` (#250). The cost is consistent and it is not
// the missing feature — it is that **a caller trusts the message and spends
// the time in the wrong place**, which is strictly worse than a refusal
// carrying no advice at all.
//
// PR #251 added a check of this shape scoped to one table and one parameter
// name. This file is the general form.
//
// **What would make this file hollow** — named first, so the tests below
// can be read against it:
//
//   1. **Sweeping a hand-written list of advice.** A check that iterates a
//      copy of the corpus proves the copy is consistent with itself and
//      says nothing about the advice a caller actually receives. So the
//      corpus is read from the registry (`collectAdvice`), and a
//      cardinality assertion below fails if that read ever silently returns
//      nothing — the empty-sweep failure that makes a green run meaningless.
//   2. **A detector that cannot fire.** A sweep reporting zero defects is
//      indistinguishable from a sweep that is broken, and this one reports
//      zero against the current tree. So the detector is pinned against the
//      real historical instances, verbatim, in "the check fails on a
//      reintroduced instance" below: if it stops catching those, the sweep
//      is dead and these tests fail rather than staying green.
//   3. **A detector that fires too easily.** The mirror risk, and the one
//      that killed the first draft of this check: a version keying on
//      snake_case name shape reported 26 defects, all false — real fields
//      (`what_to_test`, `commit_sha`) and real enum members (`code_review`,
//      `lgtm_with_nits`) read as missing tools. A check whose output is
//      mostly noise gets ignored, which loses its true positives too. So
//      the known-correct messages are pinned as negative controls, and they
//      are the cases most likely to break under a careless tightening.
import { describe, expect, it } from "vitest";
import {
  attributeTo,
  collectAdvice,
  findAdviceDefects,
  findRuleFieldDefects,
  findUndocumentedConditionalRequirements,
  requiredFieldNames,
  instructedIdentifiers,
} from "@/lib/service/describe/advice";
import { narrowerCallFor } from "@/lib/service/response-size";

/** How a defect reads in a failure, so a reader gets the remedy and not just a count. */
function describeDefects(defects: readonly { operation: string; detail: string }[]): string {
  return defects.map((defect) => `  - ${defect.operation}: ${defect.detail}`).join("\n");
}

describe("the advice surface a caller is actually shown", () => {
  // The anti-hollowness assertion for the corpus itself. Every check below
  // passes trivially against an empty list, so an advice read that silently
  // stopped finding anything would turn this whole file green and useless.
  it("is read from the registry and is not empty", () => {
    const entries = collectAdvice(narrowerCallFor);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    // Both structured sources are represented — a regression that dropped
    // one would otherwise leave the sweep quietly half-blind.
    expect(entries.some((entry) => entry.source.includes("NARROWER_CALL"))).toBe(true);
    expect(entries.some((entry) => entry.source.includes("contract.rules"))).toBe(true);
  });

  it("names no remedy the operation it is attributed to would refuse", () => {
    const defects = findAdviceDefects(collectAdvice(narrowerCallFor));
    expect(defects, `advice naming an unfollowable remedy:\n${describeDefects(defects)}`).toEqual(
      [],
    );
  });

  // The structured half, and a stronger claim than the prose one: a rule's
  // `fields` is data, and its documented job is to let a refused caller find
  // the rule that refused them without matching on prose. A name here that
  // no field answers to breaks that lookup silently.
  it("declares contract rules only about fields the operation has", () => {
    const defects = findRuleFieldDefects();
    expect(
      defects,
      `contract rules about non-existent fields:\n${describeDefects(defects)}`,
    ).toEqual([]);
  });
});

/**
 * Fields the server refuses as required from inside a handler, rather than
 * at the schema boundary — the conditional requirements a JSON Schema
 * cannot express, listed with the operations they can refuse.
 *
 * Kept as an explicit list rather than scraped out of the source: a regex
 * over `new InvalidInputError(...)` would silently shrink to zero the day
 * someone reformats a throw, and a sweep that finds nothing is a sweep that
 * passes. Adding a conditional refusal here is a deliberate act, and the
 * test below then insists the contract documents it.
 */
const CONDITIONAL_REQUIREMENTS = [
  // `create-core.ts` — refused after `resolveSessionDefaults`, because
  // before that a missing `originType` is not yet knowably missing.
  { field: "originType", operations: ["create_task", "create_project", "create_subtask"] },
  { field: "originPersonId", operations: ["create_task", "create_project", "create_subtask"] },
] as const;

describe("conditional requirements the schema cannot state are documented", () => {
  // ── Why this is a sweep and not three paragraphs ──────────────────────
  //
  // Two crews on 2026-08-31 were refused by conditionally-required fields
  // and both read the schema first, because it is the only machine-readable
  // contract they have. Both requirements turned out to be documented
  // already — but nothing enforced that, so the next one would have shipped
  // undocumented and been found the same expensive way: by a caller being
  // refused mid-task.
  //
  // This is the check that makes `describe_tool` load-bearing for the one
  // class of rule it uniquely exists to carry.

  it("documents every field that is optional in the schema but refused as required", () => {
    const defects = findUndocumentedConditionalRequirements(CONDITIONAL_REQUIREMENTS);
    expect(
      defects,
      `conditional requirements missing from describe_tool:
${describeDefects(defects)}`,
    ).toEqual([]);
  });

  // The anti-hollowness half. Everything above reports zero against the
  // current tree — which is also what a detector that lost its way reports.
  it("still detects one when the documenting rule is taken away", () => {
    // A field genuinely optional in the schema, refused at runtime, and
    // named by no rule of an unrelated operation. Fails if the detector
    // stops looking at contract rules, or starts treating every field as
    // documented.
    const defects = findUndocumentedConditionalRequirements([
      { field: "branch", operations: ["claim"] },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]!.named).toBe("branch");
    expect(defects[0]!.operation).toBe("claim");
  });

  it("does not flag a field the schema already marks required", () => {
    // `checkpoint.itemId` is required by the schema itself AND named by no
    // contract rule. Both halves matter: an undocumented field is what
    // isolates the schema-required condition, because a documented one
    // would be skipped by the documentation check first and would pass
    // whether or not the schema condition existed.
    //
    // This test was itself corrected by mutation. It originally used
    // `create_task.title`, which IS documented (by the title-convention
    // rule) — so it short-circuited on the documentation check and survived
    // deleting the schema condition entirely. That is the vacuous-negative-
    // control failure this file exists to prevent, found the only way it
    // can be: by mutating and watching nothing go red.
    expect(requiredFieldNames("checkpoint").has("itemId")).toBe(true);
    expect(
      findUndocumentedConditionalRequirements([{ field: "itemId", operations: ["checkpoint"] }]),
    ).toEqual([]);
  });
});

describe("the check fails on a reintroduced instance", () => {
  // **This is the load-bearing block of the file.** Everything above
  // reports zero against the current tree, which is exactly what a broken
  // detector also reports. These pin the detector against the real defects
  // this row was filed over, verbatim, so the sweep's silence stays
  // meaningful.

  it("catches `my_work`'s phantom `limit` — the instance that opened the row", () => {
    const defects = findAdviceDefects([
      {
        operation: "my_work",
        source: "reintroduced",
        text: "a smaller `limit`, or a narrower time range",
      },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ named: "limit", attributedTo: "my_work" });
    // The remedy in the failure names what the operation *does* accept, so
    // whoever hits this is not sent looking for the field list themselves.
    expect(defects[0]?.detail).toContain("sessionId");
  });

  it("catches the underscored `pre_approved` an operation spells with a hyphen (#250)", () => {
    const defects = findAdviceDefects([
      {
        operation: "update_item",
        source: "reintroduced",
        text: 'set `mergeAuthority: "pre_approved"` on the item with `update_item`',
      },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ kind: "enum-value", named: "pre_approved" });
    expect(defects[0]?.detail).toContain("pre-approved");
  });

  it("catches advice telling a caller to call a tool that does not exist", () => {
    const defects = findAdviceDefects([
      { operation: "transition_item", source: "reintroduced", text: "call `merge_item` to finish" },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ kind: "operation", named: "merge_item" });
  });

  // The recall widening. The verb-of-invocation rule missed a tool named as
  // a *route* rather than as an imperative, and the corpus really uses that
  // construction — `progress_report` says "the way to raise one is
  // `loop_add`". Both halves are pinned: that a dead tool in this shape is
  // now caught, and that the live operations in the same sentence are not
  // flagged, because the whole value of this class is that it is right when
  // it fires.
  it("catches a dead tool named as a route, with no verb of invocation", () => {
    const defects = findAdviceDefects([
      {
        operation: "progress_report",
        source: "reintroduced",
        text: "the way to clear one is `loop_resolve`",
      },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ kind: "operation", named: "loop_resolve" });
  });

  it("spares the live operations the same route phrasing names", () => {
    // Verbatim from `progress_report`'s own rule. Both names are
    // registered, so the widened pattern must match them and report
    // nothing — this is the control that fails if the widening ever starts
    // deciding on name shape instead of on the registry.
    const defects = findAdviceDefects([
      {
        operation: "progress_report",
        source: "reintroduced",
        text:
          "They are not authored — they are the item's OPEN LOOPS, so the way to raise one " +
          "is `loop_add` and the way to clear one is `loop_close`.",
      },
    ]);
    expect(defects).toEqual([]);
  });

  it("reads each route in a two-route sentence, not just the last", () => {
    // The bounded gap in the route pattern, pinned. `[a-z ]+` between "the
    // way to" and "is" cannot cross a backtick, so both halves of
    // `progress_report`'s real sentence are read independently. A greedy
    // `.+` there consumes the first route whole and leaves only the second
    // — which silently halves the class's recall on exactly the sentence
    // it was added for, and reports one defect where there are two.
    const defects = findAdviceDefects([
      {
        operation: "progress_report",
        source: "reintroduced",
        text: "the way to raise one is `loop_raise` and the way to clear one is `loop_resolve`",
      },
    ]);
    expect(defects.map((defect) => defect.named).sort()).toEqual(["loop_raise", "loop_resolve"]);
  });

  it("catches a contract rule about a field its operation does not have", () => {
    // The structured check, exercised through the same shape a real rule
    // has. `findRuleFieldDefects` reads the live registry, so this proves
    // the resolution logic rather than the registry's current contents:
    // a leaf that no field answers to is a defect, one that does is not.
    const defects = findAdviceDefects([
      {
        operation: "my_work",
        source: "reintroduced",
        text: "pass a `cursor` to page through them",
      },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ named: "cursor", attributedTo: "my_work" });
  });
});

describe("the check does not fire on advice that is correct", () => {
  // The negative controls. Each is a real message from the tree, and each
  // is the shape a careless tightening of the detector would break.

  it("spares a cross-tool redirect naming another tool's parameter", () => {
    // `get_item_detail` has no `full`; `get_item` does, and the advice says
    // so correctly. A detector matching parameters against the operation
    // whose message it happens to be would flag this, be wrong, and get
    // switched off.
    expect(
      findAdviceDefects([
        {
          operation: "get_item_detail",
          source: "live",
          text: "`loop_list` for this item's loops, or `get_item` with `full: false` for the slim record",
        },
      ]),
    ).toEqual([]);
  });

  it("spares a message naming a parameter in order to rule it out", () => {
    // `my_work`'s corrected message mentions `limit` precisely to say it
    // has none. Flagging a mention rather than an instruction would punish
    // the fix that closed this defect in the first place.
    expect(
      findAdviceDefects([
        {
          operation: "my_work",
          source: "live",
          text: "`release` on the items this session has finished — `my_work` takes no `limit`, so the remedy is holding fewer items rather than asking for fewer",
        },
      ]),
    ).toEqual([]);
  });

  it("spares prose describing another tool's field while explaining inheritance", () => {
    // `create_task`'s real contract rule. An earlier draft keying on "with"
    // reported all four create operations against this entirely-correct
    // text, because `personId` is `register_session`'s field being
    // described, not a field being demanded here.
    expect(
      findAdviceDefects([
        {
          operation: "create_task",
          source: "live",
          text: "a session that registered with a `personId` declares a person origin once and inherits it",
        },
      ]),
    ).toEqual([]);
  });

  it("spares real fields and enum members that merely look like tool names", () => {
    // The 26-false-positive case, pinned. These are snake_case like every
    // operation name, and every one of them is a real field or enum member.
    expect(
      findAdviceDefects([
        {
          operation: "complete_item",
          source: "live",
          text: "`how_verified` is required when `user_facing` is false, and `what_to_test` is required when it is true",
        },
        {
          operation: "record_artifact",
          source: "live",
          text: "a `code_review` at `lgtm_with_nits` still blocks on a `pull_request`",
        },
      ]),
    ).toEqual([]);
  });

  it("spares the three correct names no registry lookup can vouch for", () => {
    // **The control against the obvious widening**, and the reason the
    // tool-name class still keys on an invocation phrase rather than on
    // "snake_case token the registry does not know".
    //
    // That widening was measured against the live corpus and reports these
    // three, all false, all verbatim from real advice:
    //
    //   - `item_id` is real but lives at `summary.not_done[].item_id` —
    //     two levels below the input, past the documented one-level walk.
    //   - `commit_sha` is a free-form key inside `complete_item`'s open
    //     `fields` bag, so no schema can vouch for it, by construction.
    //   - `open_loops` names a section of the progress report, not a field.
    //
    // If a future change starts deciding this class on name shape, this
    // test goes red rather than the corpus quietly acquiring three false
    // reports.
    expect(
      findAdviceDefects([
        {
          operation: "complete_item",
          source: "live",
          text: "every reason except `descoped` requires an `item_id` naming a real item",
        },
        {
          operation: "complete_item",
          source: "live",
          text: "`fields` carries extras other guards on this transition need (a `commit_sha`, for instance)",
        },
        {
          operation: "progress_report",
          source: "live",
          text: "anything either cap withholds is counted at the foot of the report and listed in full by `open_loops`",
        },
      ]),
    ).toEqual([]);
  });

  it("spares `full: false`, the commonest correct advice in the corpus", () => {
    // A boolean is not an enum member; reporting it would flag most of the
    // table at once.
    expect(
      findAdviceDefects([
        {
          operation: "get_item",
          source: "live",
          text: "`full: false`, which returns the slim record",
        },
      ]),
    ).toEqual([]);
  });
});

describe("how a named remedy is attributed to an operation", () => {
  // The mechanism the cross-tool control above depends on, tested directly
  // so a failure says which half broke.
  it("attributes a parameter to the nearest tool named before it", () => {
    const text = "`loop_list` for the loops, or `get_item` with `full: false`";
    const at = text.indexOf("`full: false`");
    expect(attributeTo(text, at, "get_item_detail")).toBe("get_item");
  });

  it("attributes to the speaking operation when no other tool is named", () => {
    const text = "a smaller `limit`";
    expect(attributeTo(text, text.indexOf("`limit`"), "list_items")).toBe("list_items");
  });

  it("reads an instruction to supply a value, not a bare mention", () => {
    expect(instructedIdentifiers("pass a `limit`").map((found) => found.name)).toEqual(["limit"]);
    expect(instructedIdentifiers("it takes no `limit`")).toEqual([]);
  });
});
