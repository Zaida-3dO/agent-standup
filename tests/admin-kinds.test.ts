// src/lib/admin/kinds.ts — the entity-kind descriptors behind
// MILESTONES.md #93's "one page pattern per entity kind".
//
// The point of these tests is that the *pattern* is enforced rather than
// merely intended: every kind is checked against the same invariants, so a
// kind added later cannot quietly omit its help text, name a collection the
// API does not return, or offer an editor for a field the API will not
// accept. A per-kind test would pass while the fifth kind was malformed.
import { describe, expect, it } from "vitest";
import {
  ADMIN_KINDS,
  adminKindBySlug,
  createFields,
  editableFields,
  type AdminKind,
} from "@/lib/admin/kinds";

describe("the kinds SCHEMA.md §23 names", () => {
  it("covers the five installation-owned entity kinds", () => {
    // §23: "Repositories, areas, machines, accounts and people are owned by
    // the installation."
    expect(ADMIN_KINDS.map((kind) => kind.slug)).toEqual([
      "repos",
      "areas",
      "machines",
      "accounts",
      "people",
    ]);
  });

  it("finds a kind by its slug, and reports null for an unknown one", () => {
    expect(adminKindBySlug("repos")?.title).toBe("Repositories");
    // A slug that names no kind must be distinguishable from one that does,
    // so the page can 404 rather than render an empty shell.
    expect(adminKindBySlug("nonsense")).toBeNull();
    expect(adminKindBySlug("")).toBeNull();
  });

  it("gives every kind a distinct slug, so two never resolve to the same page", () => {
    const slugs = ADMIN_KINDS.map((kind) => kind.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("invariants every kind must satisfy", () => {
  const each = (assertion: (kind: AdminKind) => void) => {
    for (const kind of ADMIN_KINDS) assertion(kind);
  };

  it("points its list path at the API and names the collection it returns", () => {
    each((kind) => {
      expect(kind.listPath.startsWith("/api/"), kind.slug).toBe(true);
      expect(kind.collection.length, kind.slug).toBeGreaterThan(0);
    });
  });

  it("declares an id field that is one of its own fields", () => {
    // The id names both the row's path segment and a column shown on it; a
    // kind whose id is not a declared field would render a blank heading.
    each((kind) => {
      expect(
        kind.fields.map((field) => field.name),
        kind.slug,
      ).toContain(kind.idField);
    });
  });

  it("explains every field, so nothing is offered without saying what it does", () => {
    each((kind) => {
      for (const field of kind.fields) {
        expect(field.label.length, `${kind.slug}.${field.name} label`).toBeGreaterThan(0);
        expect(field.help.length, `${kind.slug}.${field.name} help`).toBeGreaterThan(10);
      }
    });
  });

  it("names each field once per kind", () => {
    each((kind) => {
      const names = kind.fields.map((field) => field.name);
      expect(new Set(names).size, kind.slug).toBe(names.length);
    });
  });

  it("gives every enum field its options, so a select is never empty", () => {
    each((kind) => {
      for (const field of kind.fields) {
        if (field.kind !== "enum") continue;
        expect(field.options?.length ?? 0, `${kind.slug}.${field.name}`).toBeGreaterThan(0);
      }
    });
  });

  it("never marks a field both read-only and required on create without it being the id", () => {
    // A read-only field that a create form must fill is exactly an
    // identifier — set once, never edited. Anything else in that state is a
    // field the form asks for and the API will refuse.
    each((kind) => {
      for (const field of kind.fields) {
        if (field.readOnly && field.requiredOnCreate) {
          expect(field.name, `${kind.slug}.${field.name}`).toBe(kind.idField);
        }
      }
    });
  });
});

describe("the two per-entity overrides §23.2 names, and only those", () => {
  it("marks machines' source globs and accounts' budget windows as overrides", () => {
    const overrides = ADMIN_KINDS.flatMap((kind) =>
      kind.fields
        .filter((field) => field.overridesSetting)
        .map((field) => `${kind.slug}.${field.name}:${field.overridesSetting}`),
    );
    // §17.7 states the rule as "two uses, and the door is closed to a third
    // without an argument" — so a third appearing here should fail this
    // test and force that argument to be made.
    expect(overrides.sort()).toEqual([
      "accounts.budgetWindows:budget.windows",
      "machines.sourceGlobs:minting.source_globs",
    ]);
  });
});

describe("which fields a form offers", () => {
  const repos = adminKindBySlug("repos")!;
  const machines = adminKindBySlug("machines")!;

  it("leaves read-only fields out of the editable set", () => {
    const names = editableFields(repos).map((field) => field.name);
    expect(names).not.toContain("id");
    expect(names).toContain("displayName");
    expect(names).toContain("defaultBranch");
  });

  it("includes the identifier in a create form, which the editor omits", () => {
    // "Cannot be changed afterwards" and "cannot be set at all" are
    // different things, and an identifier is the first but not the second.
    expect(createFields(repos).map((field) => field.name)).toContain("id");
    expect(editableFields(repos).map((field) => field.name)).not.toContain("id");
  });

  it("leaves a machine's reported values read-only — nothing here writes them", () => {
    const names = editableFields(machines).map((field) => field.name);
    expect(names).toEqual(["sourceGlobs"]);
    expect(names).not.toContain("lastPollAt");
    expect(names).not.toContain("liveSessions");
  });
});

describe("what each kind allows", () => {
  it("allows creating a repository deliberately, per §23.1", () => {
    expect(adminKindBySlug("repos")?.canCreate).toBe(true);
  });

  it("does not offer to create a machine, which registers itself by polling", () => {
    // A form writing a row for a machine that has never reported would
    // create an entry nothing keeps up to date.
    expect(adminKindBySlug("machines")?.canCreate).toBe(false);
  });

  it("does not offer to create a person through this API — T13's picker owns creation", () => {
    // `update_person` (#116) upserts, so a `POST`-based create here would be
    // a second path to the same write; the profile picker's own inline form
    // (T13) is where a new person is created, generating its own id.
    const people = adminKindBySlug("people")!;
    expect(people.canCreate).toBe(false);
  });

  it("DOES offer to edit an existing person, now that update_person (#116) exists — T13", () => {
    const people = adminKindBySlug("people")!;
    const names = editableFields(people).map((field) => field.name);
    expect(names).toEqual(["displayName", "avatar", "colour"]);
    expect(names).not.toContain("id");
  });

  it("marks a person's displayName requiredOnEdit — update_person's schema has no cleared state for it", () => {
    // T21: `update_person`'s `displayName` is `.min(1).optional()`, never
    // `.nullable()` — the column is NOT NULL with no "unset" state. This
    // flag is what `values.ts`'s `fromInput` reads to refuse an emptied box
    // client-side instead of sending a `null` the service would refuse
    // with an unnamed schema-mismatch message.
    const people = adminKindBySlug("people")!;
    const displayName = people.fields.find((field) => field.name === "displayName")!;
    expect(displayName.requiredOnEdit).toBe(true);
  });

  it("does NOT mark avatar or colour requiredOnEdit — both are genuinely clearable", () => {
    const people = adminKindBySlug("people")!;
    const avatar = people.fields.find((field) => field.name === "avatar")!;
    const colour = people.fields.find((field) => field.name === "colour")!;
    expect(avatar.requiredOnEdit).toBeFalsy();
    expect(colour.requiredOnEdit).toBeFalsy();
  });

  it("archives repositories, areas and people, and never offers a delete", () => {
    // §23.1: "Archive, never delete — attribution and history point at
    // these rows."
    expect(adminKindBySlug("repos")?.canArchive).toBe(true);
    expect(adminKindBySlug("areas")?.canArchive).toBe(true);
    // T13: a person can now be archived from the admin grid too, backed by
    // `update_person`'s `archived` flag (#116).
    expect(adminKindBySlug("people")?.canArchive).toBe(true);
  });

  it("does not offer to archive a machine or an account, which carry no archived column", () => {
    expect(adminKindBySlug("machines")?.canArchive).toBe(false);
    expect(adminKindBySlug("accounts")?.canArchive).toBe(false);
  });
});
