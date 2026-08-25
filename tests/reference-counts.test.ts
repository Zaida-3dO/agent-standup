// The hard-delete guard's list of referring columns, pinned against the
// schema it claims to describe (MILESTONES.md #96).
//
// ── Why this test parses `prisma/schema.prisma` ─────────────────────────
//
// `REFERRING_COLUMNS` is written out by hand, and a hand-written list of
// foreign keys has exactly one failure mode: someone adds a column
// referencing `Person` and does not add it here. The consequence is not a
// cosmetic gap. The guard would count zero, allow the delete, and Postgres
// would either refuse at the `DELETE` with a foreign-key violation or — if
// the new column has no database-level constraint — leave a dangling
// reference that surfaces as a crash at some unrelated later read.
//
// A test asserting the table against a copy of itself would pass forever.
// So this reads the schema and derives, from the relation declarations, the
// set of columns that reference each entity — then asserts the hand-written
// table matches it exactly, in both directions. Adding a relation without
// adding it to the table fails here, which is the whole point.
//
// ── What would break these tests (they are not hollow) ──────────────────
//
//   - Deleting any entry from `REFERRING_COLUMNS` fails "covers every
//     referring column in the schema" — that is the regression this exists
//     for.
//   - Adding an entry naming a column that does not reference the entity
//     fails "names no column the schema does not have".
//   - Changing a `table` or `column` string to a typo fails both directions
//     at once, because a typo'd name is simultaneously a missing real column
//     and a present fake one.
//   - Renaming an entity's table in `ENTITY_TABLE` fails "names the table
//     each entity's row lives in".
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTITY_TABLE,
  REFERENCE_ENTITIES,
  REFERRING_COLUMNS,
  describeReferenceCounts,
  type ReferenceEntity,
} from "@/lib/service/admin/reference-counts";

const schemaText = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** The Prisma model name each reference entity is stored as. */
const MODEL_FOR_ENTITY: Record<ReferenceEntity, string> = {
  repo: "Repo",
  area: "Area",
  person: "Person",
};

interface ParsedRelation {
  readonly table: string;
  readonly column: string;
  readonly target: string;
}

/**
 * Every `@relation(fields: [x], references: [id])` in the schema, with the
 * model it sits in and the model it points at.
 *
 * Deliberately a small parser over the text rather than anything that
 * imports Prisma's own metadata: the point is to read the *source of truth a
 * human edits*, so that editing it and forgetting the table is what fails.
 */
function parseRelations(text: string): ParsedRelation[] {
  const relations: ParsedRelation[] = [];
  let currentModel: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) {
      currentModel = modelMatch[1]!;
      continue;
    }
    if (line === "}") {
      currentModel = null;
      continue;
    }
    if (currentModel === null || line.startsWith("//")) continue;

    // e.g. `person Person? @relation(fields: [personId], references: [id])`
    // and the named form `@relation("Origin", fields: [originPersonId], …)`.
    const relationMatch = /^\w+\s+(\w+)\??\s+@relation\((?:"[^"]*",\s*)?fields:\s*\[(\w+)\]/.exec(
      line,
    );
    if (relationMatch) {
      relations.push({
        table: currentModel,
        column: relationMatch[2]!,
        target: relationMatch[1]!,
      });
    }
  }

  return relations;
}

const relations = parseRelations(schemaText);

describe("the schema parser this test depends on", () => {
  // If the parser silently matched nothing, every assertion below would
  // pass vacuously — the failure mode this repo calls a check that cannot
  // tell "it worked" from "it never happened". So it is pinned first.
  it("finds relations at all, including the named-relation form", () => {
    expect(relations.length).toBeGreaterThan(10);
    expect(relations).toContainEqual({
      table: "Item",
      column: "originPersonId",
      target: "Person",
    });
    expect(relations).toContainEqual({ table: "ItemArea", column: "areaId", target: "Area" });
  });
});

describe("REFERRING_COLUMNS against prisma/schema.prisma", () => {
  for (const entity of REFERENCE_ENTITIES) {
    const model = MODEL_FOR_ENTITY[entity];

    it(`covers every referring column in the schema for ${entity}`, () => {
      const fromSchema = relations
        .filter((relation) => relation.target === model)
        .map((relation) => `${relation.table}.${relation.column}`)
        .sort();
      const fromTable = REFERRING_COLUMNS[entity].map((ref) => `${ref.table}.${ref.column}`).sort();

      expect(fromTable).toEqual(fromSchema);
    });

    it(`names no column the schema does not have for ${entity}`, () => {
      for (const ref of REFERRING_COLUMNS[entity]) {
        expect(
          relations.some(
            (relation) =>
              relation.table === ref.table &&
              relation.column === ref.column &&
              relation.target === model,
          ),
        ).toBe(true);
      }
    });

    it(`gives every ${entity} reference a human label`, () => {
      for (const ref of REFERRING_COLUMNS[entity]) {
        // A refusal reads "3 items in this repo", so a label that is a
        // column name would render as "3 Item.repo" — technically true and
        // useless to the person who has to act on it.
        expect(ref.label.length).toBeGreaterThan(3);
        expect(ref.label).not.toContain(".");
      }
    });
  }

  it("names the table each entity's row lives in", () => {
    for (const entity of REFERENCE_ENTITIES) {
      expect(ENTITY_TABLE[entity]).toBe(MODEL_FOR_ENTITY[entity]);
      expect(schemaText).toContain(`model ${ENTITY_TABLE[entity]} {`);
    }
  });
});

describe("describeReferenceCounts", () => {
  it("lists only the references that actually survive", () => {
    const rendered = describeReferenceCounts([
      { table: "Item", column: "repo", label: "items in this repo", count: 3 },
      { table: "Item", column: "area", label: "items whose primary area this is", count: 0 },
      { table: "ItemArea", column: "areaId", label: "items also tagged with this area", count: 2 },
    ]);

    // The zero is absent: listing it buries the two lines that matter.
    expect(rendered).toBe("3 items in this repo, 2 items also tagged with this area");
  });

  it("renders nothing when every count is zero", () => {
    expect(
      describeReferenceCounts([
        { table: "Item", column: "repo", label: "items in this repo", count: 0 },
      ]),
    ).toBe("");
  });
});
