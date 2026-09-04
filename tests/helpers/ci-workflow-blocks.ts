// Structural readers for `.github/workflows/ci.yml`, shared by the tests that
// assert things about CI's required gates (`ci-docker-paths-filter.test.ts`,
// `ci-gate-scope-fail-closed.test.ts`).
//
// These lived in `ci-mutation-gate.test.ts` until CI mutation testing was
// removed on 2026-09-04 (see the tombstone in `docs/ci-required-checks.md`).
// That file was the original consumer, so it owned them; when it went, the
// helpers outlived it because the surviving gate tests still need to read a
// job or a step as a bounded block rather than by substring-matching the
// whole workflow.

function leadingSpaces(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? (match[1]?.length ?? 0) : 0;
}

/**
 * The text of one top-level job block, from its key line to the next key at
 * the same indentation. Scoped rather than searched whole-file so that a
 * condition belonging to a *different* job cannot satisfy an assertion about
 * this one — the same reason `ci-docker-paths-filter.test.ts` walks the
 * structure instead of substring-matching.
 */
export function extractJobBlock(yamlText: string, jobKey: string): string {
  const lines = yamlText.split("\n");
  const startIndex = lines.findIndex((line) => new RegExp(`^\\s*${jobKey}:\\s*$`).test(line));
  if (startIndex === -1) return "";

  const indent = leadingSpaces(lines[startIndex] ?? "");
  const block: string[] = [lines[startIndex] ?? ""];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() !== "" && leadingSpaces(line) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

/**
 * The text of the single step within `jobBlock` whose `if:` condition contains
 * `conditionNeedle`, from its `- name:` line to the next step at the same
 * indentation. Returns `""` when no such step exists.
 *
 * Why this is structural rather than a regex: the assertion it serves is "this
 * step's own `run:` block exits non-zero", and a regex spanning from an `if:`
 * to the next `exit 1` does not express that. A lazy `(?:.|\n)*?exit 1` will
 * happily cross into a *later* step and match that step's `exit 1` — which is
 * exactly how the previous version of this assertion came to be defeatable by
 * deleting the very line it was written to require (#129). Walking to the step
 * boundary makes the scope a property of the parser rather than a hope about
 * the input.
 */
export function extractStepBlock(jobBlock: string, conditionNeedle: string): string {
  const lines = jobBlock.split("\n");
  // Step starts are `- name:` entries; collect their indices so a step can be
  // bounded by the next one rather than by whatever text happens to follow.
  const stepStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*-\s+name:/.test(line))
    .map(({ index }) => index);

  for (let i = 0; i < stepStarts.length; i += 1) {
    const start = stepStarts[i] ?? 0;
    const end = stepStarts[i + 1] ?? lines.length;
    const stepLines = lines.slice(start, end);
    const step = stepLines.join("\n");
    // Only an `if:` match counts. Matching anywhere in the step would let a
    // diagnostic `echo` quoting the condition stand in for the condition.
    // Folded scalars (`if: >-` continued on following lines) are joined back
    // into one line first — the mutation gate's failing step is written that
    // way, and a single-line regex silently finds nothing there.
    const ifIndex = stepLines.findIndex((line) => /^\s*if:/.test(line));
    if (ifIndex === -1) continue;
    const ifLine = stepLines[ifIndex] ?? "";
    let condition = ifLine.replace(/^\s*if:\s*/, "");
    if (/^[>|][-+]?$/.test(condition.trim())) {
      const foldedIndent = leadingSpaces(ifLine);
      condition = "";
      for (const line of stepLines.slice(ifIndex + 1)) {
        if (line.trim() === "") break;
        if (leadingSpaces(line) <= foldedIndent) break;
        condition += ` ${line.trim()}`;
      }
    }
    if (condition.replace(/\s+/g, " ").includes(conditionNeedle)) return step;
  }
  return "";
}
