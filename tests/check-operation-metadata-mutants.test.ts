// The self-test for `scripts/check-operation-metadata-mutants.mjs`, following
// the precedent `tests/check-external-refs.test.ts` sets: a gate is only
// proven by seeding the violation it exists to catch and watching it fire. A
// check that has only ever been observed to pass has never been run against
// the thing it is for.
//
// It also pins what a green run does **not** mean. This script reads source
// text and never runs Stryker or a test, so it can certify that the
// annotation is present and nothing whatever about whether the metadata is
// correct — a narrower claim than its name suggests, and one worth asserting
// rather than leaving to be assumed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS, deliberately: this runs as `node scripts/…` with no build step,
// so CI can gate on it before anything is compiled.
import {
  DECLARATION,
  DISABLE_COMMENT,
  LOOKBEHIND_LINES,
  OPERATIONS_DIR,
  RESTORE_COMMENT,
  analyse,
  main,
  operationFiles,
  unannotatedDeclarations,
} from "../scripts/check-operation-metadata-mutants.mjs";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway tree with the given operation files, as a repo root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "op-metadata-"));
  temporaries.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, OPERATIONS_DIR, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return root;
}

const UNANNOTATED = `export const note = ${DECLARATION}
  name: "note",
  kind: "write",
  summary: "Leaves a timestamped remark on an item.",
  input: inputSchema,
});
`;

const ANNOTATED = `${DISABLE_COMMENT} : unkillable by construction, not untested.
export const note = ${DECLARATION}
  name: "note",
  kind: "write",
  summary: "Leaves a timestamped remark on an item.",
  ${RESTORE_COMMENT}
  input: inputSchema,
});
`;

describe("the gate fires on the seeded violation", () => {
  it("fails on a declaration with no annotation", () => {
    // The violation: metadata open to mutation, which reports as a batch of
    // survivors against assertions that visibly already exist — the confusing
    // failure this check exists to turn into a legible one.
    expect(main(tree({ "note.ts": UNANNOTATED }))).toBe(1);
  });

  it("passes once the declaration is annotated", () => {
    expect(main(tree({ "note.ts": ANNOTATED }))).toBe(0);
  });

  it("fails when it finds no declarations at all, rather than reporting success", () => {
    // A check that inspected nothing and said "fine" is worse than one that
    // did not run: it puts a green tick against a claim it never tested.
    expect(main(tree({}))).toBe(1);
    expect(main(tree({ "helpers.ts": "export const x = 1;\n" }))).toBe(1);
  });

  it("reports every unannotated declaration in a file, not just the first", () => {
    // Two operations declared in one module is a real shape here, and
    // stopping at the first would silently leave the second open.
    expect(unannotatedDeclarations(UNANNOTATED + "\n" + UNANNOTATED)).toHaveLength(2);
  });
});

describe("what counts as annotated", () => {
  it("accepts an annotation separated from the declaration by its own reasoning", () => {
    // The comment carries a written reason and that reason is the point of
    // it, so the annotation is not required to sit on the line immediately
    // above — a multi-line block is the shape actually wanted.
    const spaced = `${DISABLE_COMMENT} : line one\n// line two\n// line three\n${UNANNOTATED}`;
    expect(unannotatedDeclarations(spaced)).toEqual([]);
  });

  it("does not accept an annotation further above than the lookbehind window", () => {
    // Bounded so an unrelated disable elsewhere in the file cannot be
    // mistaken for this declaration's own.
    const filler = "// filler\n".repeat(LOOKBEHIND_LINES + 5);
    expect(unannotatedDeclarations(`${DISABLE_COMMENT}\n${filler}${UNANNOTATED}`)).toHaveLength(1);
  });

  it("does not accept an annotation already closed before the declaration", () => {
    // A restore between the two means that range ended and covers something
    // else entirely, so the declaration is genuinely unprotected. Without
    // this, one disable at the top of a file would appear to cover every
    // declaration below it however many restores intervened.
    const closed = `${DISABLE_COMMENT}\nconst other = 1;\n${RESTORE_COMMENT}\n${UNANNOTATED}`;
    expect(unannotatedDeclarations(closed)).toHaveLength(1);
  });

  it("ignores files that declare no operation", () => {
    const root = tree({ "note.ts": ANNOTATED, "helpers.ts": "export const x = 1;\n" });
    expect(operationFiles(root)).toEqual([`${OPERATIONS_DIR}/note.ts`]);
  });
});

describe("what a green run does NOT mean", () => {
  it("certifies the annotation is present, never that the metadata is right", () => {
    // The narrowest and most important limit. This file has an empty `name`
    // — exactly the mutant the annotation suppresses — and passes, because
    // the script reads for the annotation and knows nothing about the value.
    const wrong = `${DISABLE_COMMENT} : reason\nexport const note = ${DECLARATION}\n  name: "",\n  ${RESTORE_COMMENT}\n  input: inputSchema,\n});\n`;
    expect(main(tree({ "note.ts": wrong }))).toBe(0);
  });
});

describe("the real tree", () => {
  it("finds this repository's operations and reports them all annotated", () => {
    // Guards against the check silently matching nothing here — the failure
    // mode where the pattern still works on a fixture but has drifted from
    // how operations are really declared.
    const { files, offenders } = analyse();
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
