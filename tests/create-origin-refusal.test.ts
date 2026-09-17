// The origin triple's refusal, as a caller receives it.
//
// `originType` cannot be required in the schema: it may be inherited from
// the calling session's registration, which is a database fact the parse
// cannot see, so requiring it in Zod would refuse exactly the callers the
// inheritance exists to relieve. It is refused after resolution instead, by
// `assertOriginResolved`.
//
// What is pinned here is that the refusal costs ONE round trip rather than
// two. `originPersonId`'s requirement is fully determined by the answer to
// this refusal, and that answer is known at the moment the message is
// written — so a caller who fixes the named fault by choosing `person` must
// not then be refused a second time for the companion field.
//
// Pure function, no database: this file never skips.
import { describe, expect, it } from "vitest";
import { assertOriginResolved } from "@/lib/service/items/create-core";

/** The refusal, or `undefined` when the call was allowed through. */
function refusalFor(input: { originType?: string; originPersonId?: string }) {
  try {
    assertOriginResolved(input);
    return undefined;
  } catch (error) {
    return error as { message: string; fields?: readonly string[]; code?: string };
  }
}

describe("a create that resolved no originType", () => {
  it("refuses, naming the field and the values it accepts", () => {
    const error = refusalFor({});
    expect(error).toBeDefined();
    expect(error!.message).toContain("originType is required");
    for (const value of ["person", "source", "auto"]) {
      expect(error!.message, value).toContain(value);
    }
  });

  it("names originPersonId in the SAME refusal, so choosing person costs no second round trip", () => {
    // THE FINDING. A caller refused for `originType` alone, who then sent
    // `originType: "person"`, was refused again for `originPersonId` — two
    // round trips for one fixable mistake, avoidably so because the second
    // requirement follows entirely from the first refusal's own answer.
    //
    // Fails if the companion field is dropped from the message, which is
    // exactly the serial-validation behaviour being fixed.
    const error = refusalFor({});
    expect(error!.message).toContain("originPersonId");
  });

  it("says which choice triggers the companion field, not merely that it exists", () => {
    // Naming `originPersonId` without saying WHEN it applies would send a
    // caller choosing `auto` looking for a person to name. The message has
    // to tie the requirement to `person` specifically.
    //
    // Fails if the sentence is reduced to a bare mention of the field.
    const message = refusalFor({})!.message;
    const personClause = /person[^.]*originPersonId|originPersonId[^.]*person/s;
    expect(message).toMatch(personClause);
    // And says the other two need nothing further, so the requirement is not
    // read as applying to every origin.
    expect(message).toMatch(/`?source`? and `?auto`? need no companion field/);
  });

  it("reports BOTH fields, so a caller matching on `fields` sees the whole triple", () => {
    // A caller that reads `fields` programmatically rather than the prose
    // gets the same answer the prose gives. Fails if `fields` is left as
    // `["originType"]` while only the message is widened — the half-fix that
    // looks right in a transcript and is wrong to a client.
    const error = refusalFor({});
    expect(error!.fields).toContain("originType");
    expect(error!.fields).toContain("originPersonId");
  });

  it("allows a resolved originType through untouched", () => {
    // The function's only job is the unresolved case. A supplied `person`
    // with no `originPersonId` is a different fault, caught earlier at parse
    // time by the shared refinement, and must not be refused twice.
    expect(refusalFor({ originType: "person" })).toBeUndefined();
    expect(refusalFor({ originType: "auto" })).toBeUndefined();
    expect(refusalFor({ originType: "source" })).toBeUndefined();
  });
});
