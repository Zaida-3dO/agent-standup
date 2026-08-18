// The board's ordering and its keyset cursor — MILESTONES.md #75.
//
// These are string assertions over generated SQL, which is a shape worth
// justifying: the alternative is to assert only through a live database, and
// the property that matters most here — **that the cursor compares on the
// same column the page is ordered by** — is not visible in a query's result
// on a small fixture. It shows up as skipped and duplicated rows across page
// boundaries on a large one, which is exactly the defect nobody catches by
// looking.
//
// So the invariant is asserted structurally, where it is cheap and exact, and
// the database-gated suites confirm the SQL runs.
import { describe, expect, it } from "vitest";
import {
  BOARD_SORT_KEYS,
  cursorCondition,
  cursorSelectColumn,
  orderByClause,
  sqlDirection,
} from "@/lib/service/board/sort";

describe("sqlDirection", () => {
  it("maps a reader's direction straight through for the three ordinary keys", () => {
    for (const key of ["name", "created", "updated"] as const) {
      expect(sqlDirection(key, "asc")).toBe("ASC");
      expect(sqlDirection(key, "desc")).toBe("DESC");
    }
  });

  it("INVERTS priority, because P0 sorts first in the enum but is 'highest' to a reader", () => {
    // The single most surprising line in the module, and the one a
    // well-meaning simplification would remove. `Priority` is declared
    // `P0, P1, P2, P3`, so `ORDER BY "priority" ASC` puts P0 first. A reader
    // asking for priority DESCENDING means "most important at the top".
    //
    // Deleting the `if (key === "priority")` branch — one line — flips both
    // assertions below, and the resulting board would look like the sort
    // control was simply wired backwards.
    expect(sqlDirection("priority", "desc")).toBe("ASC");
    expect(sqlDirection("priority", "asc")).toBe("DESC");
  });
});

describe("orderByClause", () => {
  it("orders by the column the key names", () => {
    expect(orderByClause("created", "desc")).toContain(`"createdAt"`);
    expect(orderByClause("updated", "desc")).toContain(`"updatedAt"`);
    expect(orderByClause("priority", "desc")).toContain(`"priority"`);
    // The reader's word and the schema's word differ here — an item has no
    // `name` column, so "name" has to reach `title` or the sort is a
    // Postgres error rather than a wrong order.
    expect(orderByClause("name", "desc")).toContain(`"title"`);
    expect(orderByClause("name", "desc")).not.toContain(`"name"`);
  });

  it("always breaks ties on id, in the same direction as the key", () => {
    // Three of the four keys are non-unique. Without a tie-break, Postgres
    // may return tied rows in a different order on the next query, which
    // makes a keyset cursor skip and repeat rows — deleting the `, "id"
    // ${dir}` fragment is the one-line change that reintroduces it.
    for (const key of BOARD_SORT_KEYS) {
      expect(orderByClause(key, "asc")).toMatch(/, "id" (ASC|DESC)$/);
      expect(orderByClause(key, "desc")).toMatch(/, "id" (ASC|DESC)$/);
    }
    expect(orderByClause("created", "desc")).toBe(`ORDER BY "createdAt" DESC, "id" DESC`);
    expect(orderByClause("created", "asc")).toBe(`ORDER BY "createdAt" ASC, "id" ASC`);
  });

  it("gives the tie-break the same direction as the key, never a fixed one", () => {
    // A tie-break running the opposite way to the key makes the row
    // comparison below non-lexicographic, so the cursor's `<` stops meaning
    // "after this row in this ordering".
    const clause = orderByClause("priority", "asc");
    const directions = [...clause.matchAll(/(ASC|DESC)/g)].map((m) => m[1]);
    expect(directions).toHaveLength(2);
    expect(directions[0]).toBe(directions[1]);
  });
});

describe("cursorSelectColumn", () => {
  it("reads the column the sort orders by, so the cursor is on the page's own sequence", () => {
    // This is the whole defect the module header describes. Hardcoding
    // `"createdAt"` here — the value it had before sorting existed — leaves
    // every query valid and every page individually correct, while page two
    // of a priority-sorted column is drawn from the creation-ordered
    // sequence and silently skips and repeats rows.
    expect(cursorSelectColumn("priority")).toBe(`"priority"`);
    expect(cursorSelectColumn("name")).toBe(`"title"`);
    expect(cursorSelectColumn("created")).toBe(`"createdAt"`);
    expect(cursorSelectColumn("updated")).toBe(`"updatedAt"`);
  });
});

describe("cursorCondition", () => {
  it("compares against the column the page is ordered by", () => {
    for (const key of BOARD_SORT_KEYS) {
      expect(cursorCondition(key, "desc", 5)).toContain(cursorSelectColumn(key));
    }
  });

  it("takes rows below the cursor on a descending page and above it on an ascending one", () => {
    // Flipping this comparison returns the page the reader has already seen,
    // forever — "show more" appears to do nothing.
    expect(cursorCondition("created", "desc", 3)).toContain("<");
    expect(cursorCondition("created", "asc", 3)).toContain(">");
  });

  it("follows the SQL direction rather than the reader's, so priority inverts here too", () => {
    // `direction: "desc"` on priority is SQL `ASC`, so the cursor must take
    // rows ABOVE it. Reading the reader's direction here instead of
    // `sqlDirection` would make priority the one sort key whose second page
    // is empty.
    expect(cursorCondition("priority", "desc", 1)).toContain(">");
    expect(cursorCondition("priority", "asc", 1)).toContain("<");
  });

  it("places the sort value and the id at consecutive placeholders", () => {
    // The caller pushes exactly two values and advances its index by two. A
    // mismatch here binds a filter's value as the cursor and returns
    // nonsense with no error.
    expect(cursorCondition("created", "desc", 7)).toBe(
      `("createdAt", "id") < ($7::timestamptz, $8)`,
    );
  });

  it("casts a non-text cursor value, because Postgres will not infer it inside a row comparison", () => {
    expect(cursorCondition("created", "desc", 1)).toContain("::timestamptz");
    expect(cursorCondition("updated", "desc", 1)).toContain("::timestamptz");
    expect(cursorCondition("priority", "desc", 1)).toContain(`::"Priority"`);
  });

  it("does not cast the text key, which compares fine untyped", () => {
    // A `::text` cast here would be harmless but a `::timestamptz` on a
    // title is a runtime error — this pins that the map is per-key rather
    // than one blanket cast.
    expect(cursorCondition("name", "desc", 1)).toBe(`("title", "id") < ($1, $2)`);
  });

  it("is a row comparison, not the OR expansion, so a composite index can serve it", () => {
    for (const key of BOARD_SORT_KEYS) {
      expect(cursorCondition(key, "desc", 1)).not.toContain(" OR ");
    }
  });
});
