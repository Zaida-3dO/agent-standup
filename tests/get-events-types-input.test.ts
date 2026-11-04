// The `types` filter on `get_events`, at the layers that need no database: the
// operation's input schema, the HTTP adapter's query reader, and the front
// end's query builder. The SQL half (the limit counting only the filtered
// types, an unknown name refused against the enum's own labels) is in
// `tests/get-events-types.test.ts`, which is database-gated.
import { describe, expect, it } from "vitest";
import { queryInput } from "@/app/api/_shared/query";
import { getOperation } from "@/lib/service/registry";
import { buildFeedQuery } from "@/lib/since/state";

function requestFor(query: string): Request {
  return new Request(`http://test.invalid/api/events?${query}`);
}

function parse(input: unknown) {
  return getOperation("get_events")!.input.safeParse(input);
}

describe("get_events input schema: types", () => {
  it("accepts a list of type names", () => {
    expect(parse({ types: ["state_change"] }).success).toBe(true);
    expect(parse({ types: ["state_change", "merge"], full: true }).success).toBe(true);
  });

  it("stays optional, so an existing caller is unchanged", () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect((result as { data: { types?: unknown } }).data.types).toBeUndefined();
  });

  it("refuses an empty list, since neither 'every type' nor 'no type' is what an empty list says", () => {
    expect(parse({ types: [] }).success).toBe(false);
  });

  it("refuses an empty name inside the list", () => {
    expect(parse({ types: [""] }).success).toBe(false);
  });

  it("refuses a bare string where a list is required", () => {
    expect(parse({ types: "state_change" }).success).toBe(false);
  });

  it("refuses a list longer than the ledger has kinds of event", () => {
    const tooMany = Array.from({ length: 31 }, (_, index) => `type_${index}`);
    expect(parse({ types: tooMany }).success).toBe(false);
  });

  it("still rejects an unknown field, so the schema stays strict", () => {
    expect(parse({ type: ["state_change"] }).success).toBe(false);
  });
});

describe("GET /api/events reads types from the query string", () => {
  it("reads repeated types parameters as one list", () => {
    const input = queryInput(requestFor("types=state_change&types=merge&full=true"), "get_events");
    expect(input).toEqual({ types: ["state_change", "merge"], full: true });
  });

  it("reads a single types parameter as a one-item list, not a string", () => {
    expect(queryInput(requestFor("types=state_change"), "get_events")).toEqual({
      types: ["state_change"],
    });
  });

  it("leaves types out entirely when the parameter is absent", () => {
    expect(queryInput(requestFor("limit=5"), "get_events")).toEqual({ limit: 5 });
  });
});

describe("buildFeedQuery: types", () => {
  it("sends each type as its own repeated parameter", () => {
    const query = buildFeedQuery({ types: ["state_change", "merge"] });
    expect(query).toContain("types=state_change");
    expect(query).toContain("types=merge");
    expect(query.match(/types=/g)).toHaveLength(2);
  });

  it("omits types when none are given", () => {
    expect(buildFeedQuery({})).not.toContain("types");
    expect(buildFeedQuery({ types: [] })).not.toContain("types");
  });

  it("combines with full and since for the overnight report's state_change read", () => {
    const query = buildFeedQuery({ since: "10", limit: 50, full: true, types: ["state_change"] });
    expect(query).toContain("since=10");
    expect(query).toContain("limit=50");
    expect(query).toContain("full=true");
    expect(query).toContain("types=state_change");
  });
});
