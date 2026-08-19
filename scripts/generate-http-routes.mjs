#!/usr/bin/env node
/**
 * Generates `src/lib/http-routes.generated.ts` — the machine-readable list of
 * every HTTP route this build serves, with the methods each one accepts.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Nothing announced what the HTTP surface was. `GET /api/openapi.json`,
 * `GET /api`, and `GET /api/docs` were all 404, so a caller holding a bearer
 * token had no way to ask what it could call. The read API is genuinely
 * useful and easy to find — `GET /api/items?limit=200&full=true` works —
 * which is exactly what invites the assumption that a matching write route
 * exists. A session reasoning "read is `/api/items`, so the write must be
 * `/api/items/{id}/retype-to-task`" is making the most natural inference
 * available to it, and a 404 is not a correction: it is indistinguishable
 * from a typo, a missing token, or a route that exists but is spelled
 * slightly differently. That specific inference cost 39 failed calls and a
 * lost batch of work, and the real route (`POST /api/items/{id}/retype`) was
 * a near miss the whole time.
 *
 * ── Why generated rather than written ───────────────────────────────────
 *
 * **A hand-maintained route list is worse than none.** It starts correct,
 * drifts on the first route added by someone who did not know it existed,
 * and is then *confidently* wrong — which is a worse failure than silence,
 * because a caller has no reason to doubt it. Nothing fails when
 * documentation is out of date, so nothing keeps it up to date.
 *
 * So the list is derived from the route tree itself: Next.js's App Router
 * maps `src/app/api/**\/route.ts` onto URL paths structurally, and the HTTP
 * methods a route serves are its exported function names. Both are facts
 * about the source, and both are read here rather than restated.
 *
 * ── Why a committed artefact rather than a runtime scan ─────────────────
 *
 * The obvious alternative — scan the route tree when the index route is
 * called — cannot work in the environment this actually ships to. The
 * production image is Next's `output: "standalone"` bundle (see Dockerfile):
 * `src/` is not copied into the runner stage, so at runtime there is no
 * route tree on disk to scan. A scan would work in development, pass every
 * test, and return an empty list in production — the failure mode that is
 * hardest to notice, because the route would still answer 200.
 *
 * Generating at build time and committing the result puts the list in the
 * bundle, where it is available wherever the server runs.
 *
 * ── What stops the committed artefact going stale ───────────────────────
 *
 * `npm run check:http-routes` regenerates into memory and fails if the
 * result differs from the committed file, byte for byte. CI runs it beside
 * the other structural checks, so a route added without regenerating fails
 * the pull request that adds it, naming the command to run. That is the
 * whole drift-proofing argument: the file is not trusted because someone
 * remembered to update it, it is trusted because a check fails when they
 * did not.
 *
 * ── What this does NOT claim ────────────────────────────────────────────
 *
 * A green check means every `route.ts` under the API tree is listed with the
 * methods it exports. It does not mean the route works, that its handler is
 * reachable, or that the methods do what their names suggest. It answers one
 * question — "does this path exist, and with which methods" — which is the
 * question a 404 leaves unanswered.
 *
 * Usage:
 *   node scripts/generate-http-routes.mjs           # write the file
 *   node scripts/generate-http-routes.mjs --check   # fail if it is stale
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = path.join(REPO_ROOT, "src", "app", "api");
const OUTPUT = path.join(REPO_ROOT, "src", "lib", "http-routes.generated.ts");

/**
 * The HTTP methods Next.js recognises as route handlers. A route serves
 * exactly the ones it exports a function for; anything else 405s.
 */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Every `route.ts` under the API tree, as a path relative to it, sorted. */
function routeFiles(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      found.push(...routeFiles(full, relative));
    } else if (entry === "route.ts") {
      found.push(relative);
    }
  }
  return found;
}

/**
 * Blanks out comments while preserving every byte's position, so a method
 * name mentioned in prose cannot be read as an export.
 *
 * This matters here more than it looks: these route files carry long
 * headers that discuss the methods they serve and the ones they deliberately
 * do not ("why POST to a sub-path rather than PATCH the item"). Scanning
 * raw source would report `PATCH` on a route that only accepts `POST`,
 * which is precisely the confidently-wrong output this generator exists to
 * avoid producing.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/**
 * Turns a route file's path into the URL path it serves.
 *
 * Next.js's App Router conventions, applied in the one direction this needs:
 *   - `route.ts` is dropped — the file name is not part of the URL.
 *   - `[id]` becomes `{id}`, the spelling an API reader expects for a
 *     parameter, and the one that cannot be mistaken for a literal path
 *     segment containing brackets.
 *   - `[...path]` becomes `{path...}`, marking a catch-all as one rather
 *     than as a single parameter — a caller told `/api/ui/{path}` would
 *     reasonably assume one segment.
 *   - Route groups (`(group)`) contribute nothing to the URL. Handled so
 *     that introducing one cannot silently produce a wrong path.
 */
function urlPathFor(relative) {
  const segments = relative
    .split("/")
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .map((segment) => {
      if (segment.startsWith("[...") && segment.endsWith("]")) {
        return `{${segment.slice(4, -1)}...}`;
      }
      if (segment.startsWith("[") && segment.endsWith("]")) {
        return `{${segment.slice(1, -1)}}`;
      }
      return segment;
    });
  return `/api${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
}

/**
 * The methods a route file exports, in the canonical order of `METHODS`.
 *
 * **Both export forms are recognised, and that is not defensive coding.**
 * Most routes here declare handlers as `export async function POST(...)`,
 * but the MCP mount assigns one function to three methods
 * (`export const POST = serve`) — a real, current case. A scanner that knew
 * only the function form would have silently reported `/api/mcp` as serving
 * no methods at all, and the whole point of this generator is that a caller
 * can trust what it says. The empty-route check in `collectRoutes` below is
 * what turned that miss into a build failure rather than a quietly
 * incomplete list: it caught this exact case on the generator's first run.
 */
function methodsFor(source) {
  const stripped = withoutComments(source);
  return METHODS.filter((method) =>
    new RegExp(
      // `export async function POST(` / `export function POST(`
      `export\\s+(async\\s+)?function\\s+${method}\\b` +
        `|` +
        // `export const POST = ` — the assignment form, used by the MCP mount.
        `export\\s+(const|let|var)\\s+${method}\\s*=` +
        `|` +
        // `export { serve as POST }` — the re-export form. Recognised so
        // that adopting it cannot silently drop a method from the list.
        `export\\s*\\{[^}]*\\bas\\s+${method}\\b[^}]*\\}`,
    ).test(stripped),
  );
}

/** Reads the whole route tree into the shape the generated module exports. */
export function collectRoutes() {
  const routes = routeFiles(API_ROOT).map((relative) => {
    const source = readFileSync(path.join(API_ROOT, relative), "utf-8");
    return { path: urlPathFor(relative), methods: methodsFor(source) };
  });

  // A route file exporting no recognised method serves nothing. That is
  // almost certainly a mistake (a handler renamed, a file half-written), and
  // listing it would advertise a path that 404s — the exact failure this
  // whole mechanism exists to prevent, reintroduced from the other side.
  const empty = routes.filter((route) => route.methods.length === 0);
  if (empty.length > 0) {
    throw new Error(
      `These route files export no HTTP method, so they serve nothing:\n` +
        empty.map((r) => `  ${r.path}`).join("\n") +
        `\nEither export a handler (GET, POST, ...) or delete the file.`,
    );
  }

  // Sorted by path so the generated file's order is a function of the route
  // tree alone. Without this the output would depend on directory-read
  // order, and the staleness check would fail on machines that differ.
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/** The exact text of the generated module. */
export function render(routes) {
  const entries = routes
    .map(
      (route) =>
        `  { path: ${JSON.stringify(route.path)}, methods: [${route.methods
          .map((m) => JSON.stringify(m))
          .join(", ")}] },`,
    )
    .join("\n");

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Written by \`scripts/generate-http-routes.mjs\` from the route tree under
// \`src/app/api\`. Run \`npm run generate:http-routes\` after adding, moving or
// removing a route; \`npm run check:http-routes\` fails in CI when this file
// and the route tree disagree, which is what keeps it honest.
//
// Served by \`GET /api\` so a caller can discover the HTTP surface instead of
// inferring it from which paths happen to 404. See the generator for why
// this is a committed artefact rather than a runtime directory scan.

/** One route this build serves, and the methods it accepts. */
export interface HttpRoute {
  readonly path: string;
  readonly methods: readonly string[];
}

/** Every route under \`/api\`, sorted by path. */
export const HTTP_ROUTES: readonly HttpRoute[] = [
${entries}
] as const;
`;
}

function main() {
  const check = process.argv.includes("--check");
  const rendered = render(collectRoutes());

  if (!check) {
    writeFileSync(OUTPUT, rendered, "utf-8");
    console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT)}.`);
    return;
  }

  let committed;
  try {
    committed = readFileSync(OUTPUT, "utf-8");
  } catch {
    console.error(
      `${path.relative(REPO_ROOT, OUTPUT)} does not exist.\n` + `Run: npm run generate:http-routes`,
    );
    process.exit(1);
  }

  // Compared with line endings normalised. The file is committed with LF
  // (.gitattributes), but a Windows checkout can present CRLF on disk, and
  // failing there would be a check that reports a drift nobody can fix.
  if (committed.replace(/\r\n/g, "\n") !== rendered.replace(/\r\n/g, "\n")) {
    console.error(
      `${path.relative(REPO_ROOT, OUTPUT)} is out of date with the route tree.\n` +
        `A route was added, moved, renamed or removed without regenerating it.\n` +
        `Run: npm run generate:http-routes`,
    );
    process.exit(1);
  }

  console.log(`${path.relative(REPO_ROOT, OUTPUT)} matches the route tree.`);
}

// Only run when invoked directly, so the tests can import the two functions
// above without the script writing files or calling `process.exit`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
