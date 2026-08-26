// Renders the reconciliation report as Markdown. A pure function of the
// candidates and the counts around them, so the CLI script does no string
// building of its own beyond writing this to stdout.
import type { ReconciliationCandidate } from "./types";

export interface ReportCounts {
  /** How many non-terminal rows were checked. */
  readonly itemsChecked: number;
  /** How many merged pull requests were searched. */
  readonly pullRequestsSearched: number;
}

export function renderReport(
  candidates: readonly ReconciliationCandidate[],
  counts: ReportCounts,
): string {
  const lines: string[] = [];
  lines.push("# Shipped-row reconciliation report");
  lines.push("");
  lines.push(
    `Checked ${counts.itemsChecked} non-terminal row(s) against ${counts.pullRequestsSearched} ` +
      `merged pull request(s), for a merged PR whose title or body mentions the row's own id.`,
  );
  lines.push("");
  lines.push(
    "**This report does not close anything.** It flags candidates for a human or an agent to " +
      "confirm against the row's acceptance criteria — see the caveats at the bottom before " +
      "acting on any of it.",
  );
  lines.push("");

  if (candidates.length === 0) {
    lines.push(
      "No candidates found. No non-terminal row's id appears in any merged pull request's " +
        "title or body — see the caveats below for what that does and does not mean.",
    );
  } else {
    lines.push(`## ${candidates.length} candidate(s)`);
    lines.push("");
    for (const candidate of candidates) {
      const { item, evidence } = candidate;
      lines.push(`### ${item.title}`);
      lines.push("");
      lines.push(`- id: \`${item.id}\``);
      lines.push(
        `- state: \`${item.state}\`${item.headline ? `, headline: ${item.headline}` : ""}`,
      );
      lines.push(
        `- confidence: **${candidate.confidence}** (row id found verbatim in a merged PR)`,
      );
      lines.push(`- referencing pull request(s):`);
      for (const pr of evidence) {
        const merged = pr.mergedAt ? ` — merged ${pr.mergedAt}` : "";
        lines.push(`  - [#${pr.number} ${pr.title}](${pr.url})${merged}`);
      }
      lines.push("");
    }
  }

  lines.push("## What this could not determine");
  lines.push("");
  lines.push(
    "- **Whether a candidate's acceptance criteria are actually met.** A merged PR referencing " +
      "a row's id is evidence someone worked on it and shipped something under that id — it is " +
      "not a check that every acceptance point in the row's body was satisfied. Partial shipping " +
      "is real (see the row body for a worked example); confirm each candidate by reading the " +
      "row against what actually merged.",
  );
  lines.push(
    "- **Rows with no candidate here are not confirmed unshipped.** This report only used one " +
      "signal — the row's id appearing verbatim in a merged PR's title or body. A row whose work " +
      "shipped inside a PR that never mentioned its id (two of the four rows that motivated this " +
      "report shipped exactly that way) produces no candidate and no warning. Silence here means " +
      '"not found by this signal", not "still open".',
  );
  lines.push(
    "- **Deliverable-existence on `main` was not checked at all.** The brief for this tool named " +
      "it as the second cheap signal, but it needs the row's own acceptance criteria — which are " +
      "prose, not a structured list this script can evaluate — and a filename search on its own " +
      "was shown to mis-read at least one real row as unbuilt. That check is left to whoever " +
      "reviews a candidate, or to a human reading a row with no PR-reference candidate at all.",
  );

  return lines.join("\n");
}
