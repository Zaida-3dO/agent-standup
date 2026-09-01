// Covers the cross-row citation signal: a row id named verbatim inside an
// artifact recorded against a DIFFERENT row.
//
// The properties asserted here are the ones that decide whether the signal
// is worth acting on at all. It must never fabricate a candidate — a report
// that occasionally invents evidence is worse than the stale-row problem it
// exists to catch. It must exclude self-citations, because an artifact
// naming its own row is the ordinary healthy case and reporting it would
// bury the one interesting case under hundreds of uninteresting ones. And
// it must be honest that a row with no candidate has NOT been confirmed
// outstanding.
import { describe, expect, it } from "vitest";
import {
  CITING_ARTIFACT_KINDS,
  citationTextOf,
  crossRowCitations,
  findCitedRows,
} from "@/lib/reconcile/citations";
import type { CitableItem, CitedArtifact } from "@/lib/reconcile/types";

const ROW_A = "17e83ab8-4d4f-4d2b-a00d-92651228112b";
const ROW_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ROW_C = "12345678-90ab-cdef-1234-567890abcdef";

function item(id: string, overrides: Partial<CitableItem> = {}): CitableItem {
  return {
    id,
    title: `Row ${id.slice(0, 8)}`,
    state: "on_deck",
    headline: null,
    repo: "web",
    priority: "P2",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function artifact(overrides: Partial<CitedArtifact> = {}): CitedArtifact {
  return {
    id: "artifact-1",
    itemId: ROW_B,
    kind: "commit",
    body: null,
    ref: null,
    commitSha: "abc1234",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("citationTextOf", () => {
  it("reads both body and ref, so a citation in either is visible", () => {
    const text = citationTextOf(artifact({ body: `fixes ${ROW_A}`, ref: `branch/${ROW_C}` }));
    expect(text).toContain(ROW_A);
    expect(text).toContain(ROW_C);
  });

  it("does not read commitSha, which cannot contain a hyphenated uuid", () => {
    // Guards the stated reason for excluding it: if `commitSha` were
    // concatenated in, a sha that happened to embed a uuid-shaped run would
    // become a citation. The field is deliberately not scanned.
    const text = citationTextOf(artifact({ body: null, ref: null, commitSha: ROW_A }));
    expect(text).not.toContain(ROW_A);
  });

  it("survives both fields being absent", () => {
    expect(citationTextOf(artifact({ body: null, ref: null })).trim()).toBe("");
  });
});

describe("crossRowCitations", () => {
  it("finds a row id cited in an artifact belonging to another row", () => {
    const cited = crossRowCitations(
      artifact({ itemId: ROW_B, body: `Centralised the comparison. ${ROW_A} proved the defect.` }),
    );
    expect(cited.has(ROW_A)).toBe(true);
  });

  it("EXCLUDES the artifact's own row — a self-citation is the healthy case", () => {
    // The signal is specifically cross-row. A commit message citing the row
    // it is delivering is the ordinary correct behaviour, and reporting it
    // would drown the real signal.
    const cited = crossRowCitations(artifact({ itemId: ROW_A, body: `delivers ${ROW_A}` }));
    expect(cited.has(ROW_A)).toBe(false);
    expect(cited.size).toBe(0);
  });

  it("keeps a cross-row citation while dropping the self-citation in the same body", () => {
    const cited = crossRowCitations(
      artifact({ itemId: ROW_B, body: `delivers ${ROW_B}, and also fixes ${ROW_A}` }),
    );
    expect(cited.has(ROW_A)).toBe(true);
    expect(cited.has(ROW_B)).toBe(false);
  });

  it("matches an id regardless of the case it was written in", () => {
    const cited = crossRowCitations(
      artifact({ itemId: ROW_B, body: `fixes ${ROW_A.toUpperCase()}` }),
    );
    expect(cited.has(ROW_A)).toBe(true);
  });

  it("finds an id in a ref, not only in a body", () => {
    const cited = crossRowCitations(artifact({ itemId: ROW_B, body: null, ref: `feat/${ROW_A}` }));
    expect(cited.has(ROW_A)).toBe(true);
  });
});

describe("findCitedRows", () => {
  it("reports a candidate for a row another row's commit cited", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: `fixed alongside ${ROW_A}` })],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.item.id).toBe(ROW_A);
    expect(candidates[0]!.evidence[0]!.citedBy).toBe(ROW_B);
    expect(candidates[0]!.reason).toBe("cited-by-another-rows-artifact");
  });

  it("reports NOTHING for a row nobody cited — never fabricates a candidate", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: "an ordinary commit naming no row" })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("reports nothing when there are no artifacts at all", () => {
    expect(findCitedRows({ items: [item(ROW_A)], artifacts: [] })).toHaveLength(0);
  });

  // ── The error paths ───────────────────────────────────────────────────

  it("ignores a citation of a row that does not exist in the checked set", () => {
    // A body quoting an id from another installation, or a typo, must
    // produce nothing — not a candidate for a row nobody can open.
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: `see ${ROW_C}` })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("collapses a row cited twice into ONE candidate carrying both pieces of evidence", () => {
    // A row cited by two separate artifacts is one stale row with two
    // reasons to look, not two rows to triage.
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({ id: "a1", itemId: ROW_B, body: `part one of ${ROW_A}` }),
        artifact({ id: "a2", itemId: ROW_C, body: `part two of ${ROW_A}` }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidence).toHaveLength(2);
    expect(candidates[0]!.evidence.map((e) => e.artifactId).sort()).toEqual(["a1", "a2"]);
  });

  it("collapses two citations of the same row by the SAME artifact into one evidence entry", () => {
    // `crossRowCitations` returns a Set, so an artifact that names a row
    // twice in one body must not count as two independent sightings.
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: `${ROW_A} — and again, ${ROW_A}` })],
    });
    expect(candidates[0]!.evidence).toHaveLength(1);
  });

  it("finds a citation carried in a body when the artifact has no ref", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: `fixes ${ROW_A}`, ref: null })],
    });
    expect(candidates).toHaveLength(1);
  });

  it("finds a citation carried in a ref when the artifact has no body", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, body: null, ref: `https://example.test/pr/${ROW_A}` })],
    });
    expect(candidates).toHaveLength(1);
  });

  it("does not report a row whose only citation is its own artifact", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_A, body: `work on ${ROW_A}` })],
    });
    expect(candidates).toHaveLength(0);
  });

  // ── Kind filtering ────────────────────────────────────────────────────

  it("ignores an artifact of a kind that carries no argument about the work", () => {
    // A screenshot naming a row says nothing about whether that row's work
    // landed, so it must not raise a candidate.
    expect(CITING_ARTIFACT_KINDS).not.toContain("screenshot");
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, kind: "screenshot", body: `see ${ROW_A}` })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("reads a historical_verification, the artifact that records inspecting merged code", () => {
    expect(CITING_ARTIFACT_KINDS).toContain("historical_verification");
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({
          itemId: ROW_B,
          kind: "historical_verification",
          body: `already done under ${ROW_A}`,
        }),
      ],
    });
    expect(candidates).toHaveLength(1);
  });

  // ── Confidence ────────────────────────────────────────────────────────

  it("rates a commit citation high — the work actually landed", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, kind: "commit", body: `fixes ${ROW_A}` })],
    });
    expect(candidates[0]!.confidence).toBe("high");
  });

  it("rates a plan-only citation medium — somebody was thinking about it, nothing shipped", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [artifact({ itemId: ROW_B, kind: "plan", body: `will also cover ${ROW_A}` })],
    });
    expect(candidates[0]!.confidence).toBe("medium");
  });

  it("rates a row high when ANY of its citations landed, even mixed with a plan", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({ id: "a1", itemId: ROW_B, kind: "plan", body: `will cover ${ROW_A}` }),
        artifact({ id: "a2", itemId: ROW_C, kind: "commit", body: `covered ${ROW_A}` }),
      ],
    });
    expect(candidates[0]!.confidence).toBe("high");
  });

  it("rates a merge_override citation high — it names a real sha", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({ itemId: ROW_B, kind: "merge_override", body: `landed with ${ROW_A}` }),
      ],
    });
    expect(candidates[0]!.confidence).toBe("high");
  });

  // ── Ordering ──────────────────────────────────────────────────────────

  it("sorts evidence newest-first, so the most recent citation reads first", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({
          id: "older",
          itemId: ROW_B,
          body: `${ROW_A}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        artifact({
          id: "newer",
          itemId: ROW_C,
          body: `${ROW_A}`,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });
    expect(candidates[0]!.evidence.map((e) => e.artifactId)).toEqual(["newer", "older"]);
  });

  it("breaks a createdAt tie on artifact id, so two runs cannot disagree", () => {
    const sameInstant = "2026-08-01T00:00:00.000Z";
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({ id: "b-second", itemId: ROW_B, body: `${ROW_A}`, createdAt: sameInstant }),
        artifact({ id: "a-first", itemId: ROW_C, body: `${ROW_A}`, createdAt: sameInstant }),
      ],
    });
    expect(candidates[0]!.evidence.map((e) => e.artifactId)).toEqual(["a-first", "b-second"]);
  });

  it("returns candidates in the order the rows were given", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A), item(ROW_C)],
      artifacts: [
        artifact({ id: "a1", itemId: ROW_B, body: `${ROW_C}` }),
        artifact({ id: "a2", itemId: ROW_B, body: `${ROW_A}` }),
      ],
    });
    expect(candidates.map((c) => c.item.id)).toEqual([ROW_A, ROW_C]);
  });

  it("carries the citing row's title and state through, so a reader need not look it up", () => {
    const candidates = findCitedRows({
      items: [item(ROW_A)],
      artifacts: [
        artifact({
          itemId: ROW_B,
          body: `fixes ${ROW_A}`,
          itemTitle: "Centralise the comparison",
          itemState: "merged",
        }),
      ],
    });
    expect(candidates[0]!.evidence[0]!.citedByTitle).toBe("Centralise the comparison");
    expect(candidates[0]!.evidence[0]!.citedByState).toBe("merged");
  });
});
