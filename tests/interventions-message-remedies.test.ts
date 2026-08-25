// Every intervention message names a remedy the caller can actually follow.
//
// **The defect class, and why an intervention needs its own sweep.** PR #255
// added a check of exactly this shape and pointed it at the operations
// registry, because that is where the advice corpus lived: five times in one
// month this repository shipped a refusal naming a remedy that did not
// exist, and the cost was consistent — a caller trusts the message and
// spends the time in the wrong place, which is worse than a refusal carrying
// no advice at all.
//
// Intervention messages are the same corpus by a different route, and they
// are read under worse conditions: a `block-overridable` entry's message is
// the only thing standing between a caller and work it believes it should be
// doing. The catalogue's own cautionary example is the kill guard, which was
// right on most firings and **catastrophic on the one where its message told
// the caller to kill by process id and the same guard then refused a
// process-id-scoped kill.** The catalogue calls that a score of 1: not a low
// score, an explicit request for removal.
//
// **What would make this file hollow**, named first so the tests read
// against it:
//
//   1. **Sweeping a hand-written list of messages.** A check over a copy of
//      the corpus proves the copy is self-consistent. So the messages are
//      read from `BUILTIN_INTERVENTIONS`, and a cardinality assertion fails
//      if that read ever returns nothing.
//   2. **A detector that cannot fire.** A sweep reporting zero defects is
//      indistinguishable from a broken one, and this reports zero against
//      the current tree. So it is pinned against a fabricated message naming
//      an operation that does not exist, which must be caught.
import { describe, expect, it } from "vitest";
import { isOperationName } from "@/lib/service/registry";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { isBlockingLevel } from "@/lib/interventions/types";

/**
 * The operation names a message tells the reader to call.
 *
 * Matched on backticked snake_case identifiers, which is how every message
 * in this corpus spells a call. Deliberately narrow: prose naming an
 * operation without backticks is not an instruction a caller can
 * copy-paste, and reading it as one is how the first draft of #255's check
 * produced 26 false positives and had to be tightened.
 */
function namedOperations(text: string): readonly string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every message the catalogue can show, with where it came from. */
function messageCorpus(): readonly { entryId: string; kind: string; text: string }[] {
  return BUILTIN_INTERVENTIONS.flatMap((entry) => [
    { entryId: entry.id, kind: "plain", text: entry.messages.plain },
    { entryId: entry.id, kind: "prominent", text: entry.messages.prominent },
  ]);
}

describe("the remedies intervention messages name", () => {
  it("reads a corpus that is actually there", () => {
    // The anti-hollowness assertion. Every check below passes trivially
    // against an empty list, so a corpus read that silently stopped finding
    // anything would turn this whole file green and useless.
    const corpus = messageCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    expect(corpus.every((entry) => entry.text.trim().length > 0)).toBe(true);
  });

  it("names only operations this build actually exposes", () => {
    // The #255 defect, in the intervention corpus. A message telling a
    // caller to run `create_task` is followable; one naming an operation
    // that does not exist sends it looking for a tool it will never find,
    // and it will believe the fault is its own.
    const defects: string[] = [];
    for (const entry of messageCorpus()) {
      for (const named of namedOperations(entry.text)) {
        if (!isOperationName(named)) {
          defects.push(
            `${entry.entryId} (${entry.kind}) names \`${named}\`, which is not an operation`,
          );
        }
      }
    }

    expect(defects, defects.join("\n")).toEqual([]);
  });

  it("catches a message naming an operation that does not exist", () => {
    // The detector must be able to fire. Without this, a sweep that stopped
    // recognising anything would report zero defects and read as a pass —
    // which is the failure mode that makes a green check worthless.
    const fabricated = "Call `mint_the_thing` to fix this.";
    const named = namedOperations(fabricated);

    expect(named).toContain("mint_the_thing");
    expect(named.some((operation) => !isOperationName(operation))).toBe(true);
  });

  it("still recognises a real operation, so the check is not merely strict", () => {
    // The mirror risk, and the one that killed the first draft of #255's
    // check: a detector that flags everything gets ignored, which loses its
    // true positives too.
    const real = "Create a task for it with `create_task` and claim that.";

    expect(namedOperations(real)).toContain("create_task");
    expect(namedOperations(real).every((operation) => isOperationName(operation))).toBe(true);
  });

  it("gives every blocking entry a way through in its own message", () => {
    // **The kill guard's lesson, encoded.** An entry that refuses a call and
    // does not say what the caller may do instead leaves it with no move
    // except to override — and an override the message never mentioned is
    // one the caller does not know it has. Every blocking entry here is
    // `block-overridable` by the catalogue's rule that the value is the
    // recorded reason rather than the friction, so each must say so.
    for (const entry of BUILTIN_INTERVENTIONS) {
      if (!isBlockingLevel(entry.defaultLevel)) continue;
      for (const text of [entry.messages.plain, entry.messages.prominent]) {
        expect(text.toLowerCase(), `${entry.id} names no route through`).toMatch(
          /reason|instead|say why|say so/,
        );
      }
    }
  });

  it("tells the reader what to do, not merely what is wrong", () => {
    // The catalogue's own instruction for writing an entry: *"the message
    // should say what to do next, not what went wrong"*. Checked as the
    // presence of an imperative, which is the cheapest observable proxy —
    // a message with no verb addressed to the reader is a description.
    //
    // **Sentence-initial, and that is what makes the check mean anything.**
    // The same verbs appear as nouns and participles throughout these
    // messages — "recording work", "your change" — so a pattern matching
    // them anywhere passes on a message stripped of every instruction: swap
    // one entry's advice for "This is a situation." and the surrounding
    // prose still carries the words, so an unanchored pattern reports a
    // pass. Anchoring to the start of a sentence separates telling the
    // reader to do something from merely containing the word, and a mutant
    // of exactly that shape is what the anchor is verified against.
    const imperative =
      /(^|[.!?:;—]\s+)(stage|kill|find|take|create|claim|spawn|request|release|record|say|read|proceed|mint|either|call|work out)\b/i;

    for (const entry of messageCorpus()) {
      expect(entry.text, `${entry.entryId} (${entry.kind}) states no action`).toMatch(imperative);
    }
  });
});
