#!/usr/bin/env node
/**
 * Reports non-terminal board rows whose work looks already shipped, so a
 * crew is not dispatched to rebuild something a merged pull request already
 * delivered. Row `17e83ab8-4d4f-4d2b-a00d-92651228112b`.
 *
 * ── What this is ────────────────────────────────────────────────────────
 *
 * A REPORT, not an automation. It never transitions, archives or closes an
 * item — it prints Markdown naming candidates and the evidence for each,
 * for a human or an agent to confirm. That is a deliberate constraint, not
 * caution for its own sake: the row this was built for names three ways an
 * automated closer would be confidently wrong (a row is not a pull request;
 * partial shipping is real; a deliverable existing on `main` is not the
 * same fact as a row's acceptance criteria being met). See
 * `src/lib/reconcile/shipped-rows.ts` for the full reasoning and
 * `src/lib/reconcile/render-report.ts` for what the report says it could
 * not determine.
 *
 * ── The one signal this uses ────────────────────────────────────────────
 *
 * A merged pull request whose title or body contains a non-terminal row's
 * own id, verbatim, as a UUID. Both of the informal alternatives —
 * matching on branch name, matching on PR title against row title — missed
 * real matches when checked by hand against the rows that motivated this
 * tool, because two of those rows shipped inside a PR titled for other work
 * entirely. Deliverable-existence (does the row's stated component exist on
 * `main`) is the other signal named in the brief; it is NOT attempted here,
 * because it needs the row's own prose acceptance criteria evaluated
 * against merged source, which is exactly the "flag it, let a human
 * confirm" territory this script hands off rather than guesses at.
 *
 * ── What it talks to ─────────────────────────────────────────────────────
 *
 *   - `GET /api/items` on the running server, for every non-terminal row.
 *     Same `STANDUP_URL` / `STANDUP_TOKEN` precedence the `standup` CLI
 *     uses (README.md, "Point each machine at the server"). This script
 *     does NOT read `DATABASE_URL` — it is a client, not the server, and
 *     going through the API is what keeps it working unmodified against a
 *     server on another machine.
 *   - `gh pr list --state merged`, one call for the whole repository. If
 *     `gh` is missing, unauthenticated or the call otherwise fails, this
 *     degrades to reporting zero pull requests searched — same posture as
 *     `scripts/sweep-worktrees.mjs`'s `pullRequestStates()`: "could not ask"
 *     must not be able to fabricate a candidate, only fail to find one.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   STANDUP_URL=http://localhost:3000 STANDUP_TOKEN=... \
 *     node scripts/reconcile-shipped-rows.mjs
 *
 *   node scripts/reconcile-shipped-rows.mjs --limit 500   # cap PRs searched
 *   node scripts/reconcile-shipped-rows.mjs --json        # machine-readable
 *
 * Exits 0 whether or not candidates were found — this is a report, and an
 * empty candidate list is a valid, useful answer, not a failure. Exits 1
 * only when it could not reach the item source at all (bad/missing
 * `STANDUP_URL`, auth failure, network error) — silently reporting "no
 * candidates" from a source it never actually read would be worse than the
 * failure it hid.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  let limit = 400;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      limit = Number(argv[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/reconcile-shipped-rows.mjs [--limit N] [--json]\n\n" +
          "  --limit N   Max merged pull requests to search (default 400).\n" +
          "  --json      Print the raw candidate list as JSON instead of Markdown.\n\n" +
          "Requires STANDUP_URL (and STANDUP_TOKEN if the server needs one) pointed\n" +
          "at a running agent-standup server. Uses `gh` for merged pull requests —\n" +
          "run from inside a checkout of the repository being reconciled.",
      );
      process.exit(0);
    }
  }
  return { limit, json };
}

/**
 * Every non-terminal item on the board, paginated through `GET /api/items`.
 *
 * `includeTerminal` defaults to false server-side (list-items.ts), which is
 * exactly "non-terminal" — no separate filtering needed here. `full: true`
 * is NOT passed: the matcher only reads id/title/state/headline, and the
 * slim `ItemSummaryRecord` shape (src/lib/service/items/row.ts) already
 * returns exactly those four fields — it does NOT include `priority`, so
 * this report shows headline instead. Asking for whole records would cost
 * every row's body and customFields for nothing this script uses.
 *
 * Throws on any non-2xx response or a body that isn't the shape expected,
 * rather than returning an empty list — see the module header on why a
 * source that could not be read must not report zero candidates as though
 * it had been.
 */
async function fetchNonTerminalItems(baseUrl, token) {
  const items = [];
  let cursor;
  for (;;) {
    const url = new URL("/api/items", baseUrl);
    url.searchParams.set("includeTerminal", "false");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `GET ${url.pathname}${url.search} → ${response.status} ${response.statusText}\n${body}`,
      );
    }
    const payload = await response.json();
    if (!Array.isArray(payload.items)) {
      throw new Error(
        `GET ${url.pathname}${url.search} returned no "items" array — got: ${JSON.stringify(payload).slice(0, 300)}`,
      );
    }
    for (const item of payload.items) {
      items.push({
        id: item.id,
        title: item.title,
        state: item.state,
        headline: item.headline ?? null,
      });
    }
    if (!payload.nextCursor) break;
    cursor = payload.nextCursor;
  }
  return items;
}

/**
 * Every merged pull request in the current repository, via `gh`.
 *
 * Mirrors `pullRequestStates()` in scripts/sweep-worktrees.mjs: one call for
 * the whole repo, degrades to an empty list (never throws) when `gh` is
 * missing, unauthenticated or rate-limited. That direction is safe here for
 * the same reason it is safe there — losing `gh` can only ever REDUCE the
 * candidate list this script produces, never invent one.
 *
 * No `shell: isWindows` — matches the existing `gh` call in
 * sweep-worktrees.mjs. `gh` installs as a real `.exe` on Windows (verified
 * on this machine, gh 2.89.0), unlike `npx`, which is why that file's own
 * `npx` calls need the shell and its `gh` call does not.
 */
function fetchMergedPullRequests(limit) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        String(limit),
        "--json",
        "number,title,body,url,mergedAt",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch {
    return { pullRequests: [], available: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { pullRequests: [], available: false };
  }
  if (!Array.isArray(parsed)) return { pullRequests: [], available: false };
  return {
    pullRequests: parsed.map((pr) => ({
      number: pr.number,
      title: pr.title ?? "",
      body: pr.body ?? null,
      url: pr.url ?? "",
      mergedAt: pr.mergedAt ?? null,
    })),
    available: true,
  };
}

/**
 * The logic lives in TypeScript under `src/lib/reconcile/`, where it is
 * typechecked and unit-tested directly (no bundling needed from the test
 * side — `tests/*.test.ts` imports it through the `@/` alias same as any
 * other source module). This script is plain JavaScript and cannot resolve
 * that alias itself, so it bundles the same three modules with esbuild —
 * the same approach `scripts/backfill.mjs` uses and explains in its own
 * header, for the same reason: this is a script, not something `next build`
 * compiles for it.
 */
async function loadReconciler() {
  const { build } = await import("esbuild");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = await mkdtemp(path.join(os.tmpdir(), "reconcile-shipped-rows-"));
  const outfile = path.join(outDir, "reconciler.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "src/lib/reconcile/index.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

async function main() {
  const { limit, json } = parseArgs(process.argv.slice(2));

  const baseUrl = process.env.STANDUP_URL;
  if (!baseUrl) {
    console.error(
      "[reconcile-shipped-rows] STANDUP_URL is not set — point it at a running agent-standup " +
        'server (see README.md, "Point each machine at the server"). Refusing to guess.',
    );
    process.exit(1);
  }

  let items;
  try {
    items = await fetchNonTerminalItems(baseUrl, process.env.STANDUP_TOKEN);
  } catch (error) {
    console.error(
      `[reconcile-shipped-rows] could not read items from ${baseUrl}: ${error.message}`,
    );
    process.exit(1);
  }

  const { pullRequests, available } = fetchMergedPullRequests(limit);
  if (!available) {
    console.error(
      "[reconcile-shipped-rows] `gh pr list` did not succeed (missing, unauthenticated, or " +
        "rate-limited) — continuing with zero pull requests searched. This can only make the " +
        "candidate list SMALLER than it should be, never larger; re-run with `gh` working to " +
        "get a real answer.",
    );
  }

  const { findShippedCandidates, renderReport } = await loadReconciler();
  const candidates = findShippedCandidates({ items, mergedPullRequests: pullRequests });

  if (json) {
    console.log(
      JSON.stringify(
        { candidates, itemsChecked: items.length, pullRequestsSearched: pullRequests.length },
        null,
        2,
      ),
    );
  } else {
    console.log(
      renderReport(candidates, {
        itemsChecked: items.length,
        pullRequestsSearched: pullRequests.length,
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
