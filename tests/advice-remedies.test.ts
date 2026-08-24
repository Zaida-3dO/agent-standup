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
