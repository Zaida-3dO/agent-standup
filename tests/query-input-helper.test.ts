// `queryInput` (`src/app/api/_shared/query.ts`) — the schema-driven GET
// query reader. Unit-level, no database: this reads an operation's `input`
// Zod schema and `describeFields`'s answer about it, neither of which
// touches Postgres, so these cases run everywhere `npm run test` does.
//
// Integration coverage of the two real drops this closed (`get_projects`
// limit/cursor, `get_board` trust) lives in `tests/http-read-surface-fields.test.ts`,
// which is DB-gated because it asserts on rows. This file is the other half:
// the helper's own coercion rules, provable without a database at all.
import { describe, expect, it } from "vitest";
import { queryInput } from "@/app/api/_shared/query";

function requestFor(query: string): Request {
  return new Request(`http://test.invalid/api/whatever?${query}`);
}

describe("queryInput", () => {
  it("reads every declared field of a real operation by name", () => {
    // `get_projects` declares area, repo, includeCompleted, includeArchived,
    // limit, cursor — the exact set this operation's HTTP route dropped two
    // of before this fix (limit, cursor).
    const input = queryInput(
      requestFor("area=web&repo=agent-standup&limit=10&cursor=abc"),
      "get_projects",
    );
    expect(input).toEqual({ area: "web", repo: "agent-standup", limit: 10, cursor: "abc" });
  });

  it("omits a field entirely when absent, so the operation's own default applies", () => {
    const input = queryInput(requestFor("area=web"), "get_projects");
    expect(input).toEqual({ area: "web" });
    expect("limit" in input).toBe(false);
    expect("includeCompleted" in input).toBe(false);
  });

  it("coerces a boolean field through parseBooleanParam — bare, 1 and true all mean true", () => {
    expect(queryInput(requestFor("includeCompleted"), "get_projects")).toEqual({
      includeCompleted: true,
    });
    expect(queryInput(requestFor("includeCompleted=1"), "get_projects")).toEqual({
      includeCompleted: true,
    });
    expect(queryInput(requestFor("includeCompleted=true"), "get_projects")).toEqual({
      includeCompleted: true,
    });
    expect(queryInput(requestFor("includeCompleted=false"), "get_projects")).toEqual({
      includeCompleted: false,
    });
  });

  it("passes an unrecognised boolean spelling through as the raw string, for the schema to refuse", () => {
    const input = queryInput(requestFor("includeCompleted=maybe"), "get_projects");
    expect(input).toEqual({ includeCompleted: "maybe" });
  });

  it("coerces a finite numeric field to a number", () => {
    const input = queryInput(requestFor("limit=25"), "get_projects");
    expect(input.limit).toBe(25);
    expect(typeof input.limit).toBe("number");
  });

  it("passes a non-numeric value for a numeric field through as the raw string, for the schema to name it", () => {
    const input = queryInput(requestFor("limit=lots"), "get_projects");
    expect(input).toEqual({ limit: "lots" });
  });

  it("reads an array<…> field with every repetition, via getAll", () => {
    // `get_activity` declares `type: z.array(z.string()).optional()` among
    // its list filters.
    const input = queryInput(requestFor("type=note&type=claim"), "get_activity");
    expect(input.type).toEqual(["note", "claim"]);
  });

  it("omits an array<…> field entirely when no repetition is present", () => {
    const input = queryInput(requestFor(""), "get_activity");
    expect("type" in input).toBe(false);
  });

  it("respects the exempt list, reading nothing for a named field even when present on the wire", () => {
    const input = queryInput(requestFor("level=exclude%3A0&priority=P1"), "get_board", ["level"]);
    expect(input).toEqual({ priority: "P1" });
    expect("level" in input).toBe(false);
  });

  it("returns an empty object for a name that is not a registered operation", () => {
    const input = queryInput(requestFor("anything=here"), "not_a_real_operation");
    expect(input).toEqual({});
  });
});
