#!/usr/bin/env node
/**
 * Generates `src/lib/cli/bindings/cli-routes.generated.ts` — how the command
 * line's `http` binding addresses every operation the web API serves.
 *
 * ── Why the map is derived, and not written ─────────────────────────────
 *
 * The `http` binding used to carry a hand-written `RouteSpec` per operation:
 * 68 of them, across eight files and 612 lines, each restating a method, a
 * path template, which input field rides in the path, and which key to pull
 * the result out of. Every one of those four facts is **already declared by
 * the route that serves it**, so the table was a second, independently
 * maintained copy of the route tree — the exact shape
 * `generate-http-routes.mjs` argues against in its own header: a
 * hand-maintained map starts correct, drifts on the first route added by
 * someone who did not know it existed, and is then confidently wrong.
 *
 * Nothing failed when the two disagreed. They could only be compared by
 * reading both, which is why 39 of the 68 entries had drifted into
 * restating the identity `unwrap` in six lines apiece.
 *
 * ── Why the eight-file split is not preserved ───────────────────────────
 *
 * `http-routes-admin.ts`'s header says it is a separate file because
 * "several rows land entries in that same route map concurrently... so this
 * keeps the admin entries in a file nothing else touches." That is
 * merge-conflict avoidance that became architecture. Generating the map
 * removes the conflict surface outright: two branches adding two routes now
 * each add a `route.ts` and regenerate, and the generated file is a
 * derived artefact that is rebuilt rather than merged.
 *
 * ── The four facts, and where each is read from ─────────────────────────
 *
 * For every `service.call("<op>", <input>, ...)` inside a file named exactly
 * `route.ts`:
 *
 *   1. **method** — the exported handler the call sits inside
 *      (`export async function PATCH`). Attributed by position: the source
 *      is split at handler boundaries and the call is matched within one
 *      block, NOT by a character window, which would mis-attribute a call
 *      in a file exporting several methods.
 *   2. **path** — the file's location in the App Router tree, with `[id]`
 *      read as a parameter. Identical conventions to
 *      `generate-http-routes.mjs`, which is the sibling that publishes the
 *      same tree to API callers.
 *   3. **pathFields** — which input field each path parameter carries, read
 *      from the call's own input expression. `{ ...body, id }` binds `id`
 *      to `id`; `{ ...body, eventId: id }` binds the path's `id` to the
 *      field `eventId`. This is what stops a path id also being sent in the
 *      body, where a `.strict()` schema would see the same value arrive
 *      twice under two spellings.
 *   4. **unwrapKey** — see the section below, which is the one fact this
 *      generator refuses to infer.
 *
 * ── The unwrap key is DECLARED, not derived, and that is deliberate ─────
 *
 * A route's success response is an expression, not a structure, and reading
 * it with a regex was tried and produces confidently-wrong output in at
 * least two measured ways:
 *
 *   - **Multi-key envelopes.** `loop_add` answers
 *     `{ loopId, kind, event }` and `loop_edit`
 *     `{ loopId, previousText, event }`. A "first key wins" reading returns
 *     `loopId` where the correct answer is the whole body — a binding that
 *     silently hands back a fragment where `direct` hands back the answer.
 *   - **Nested braces.** `record_artifact` answers
 *     `{ artifact: { ...artifact, createdAt } }`, which defeats a flat
 *     object-literal matcher.
 *
 * So `UNWRAP` below is hand-declared — one short line per operation instead
 * of a six-to-fourteen-line `RouteSpec` — and it is **checked rather than
 * trusted**: `assertUnwrapCoverage` fails when it names an operation the
 * route tree does not serve, or omits one it does. Drift is impossible in
 * either direction, which is what makes a declaration trustworthy.
 *
 * Inferring this fourth fact would have been the failure this whole
 * mechanism exists to avoid, reintroduced from the other side.
 *
 * ── What a green check means, and what it does not ──────────────────────
 *
 * It means every operation the web API serves is addressable by the `http`
 * binding, with the method and path the route actually exports. It does not
 * mean the call succeeds, that the operation's schema accepts what the
 * command line builds, or that the unwrapped shape equals `direct`'s —
 * `tests/cli-http-binding.test.ts` and the adapter-conformance suite own
 * those, and this does not replace them.
 *
 * Usage:
 *   node scripts/generate-cli-routes.mjs           # write the file
 *   node scripts/generate-cli-routes.mjs --check   # fail if it is stale
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = path.join(REPO_ROOT, "src", "app", "api");
const OUTPUT = path.join(REPO_ROOT, "src", "lib", "cli", "bindings", "cli-routes.generated.ts");

/** The HTTP methods Next.js recognises as route handlers. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * How each operation's result is pulled out of its response body.
 *
 * `null` means the body IS the result — the shape `direct` returns for the
 * same call, which is what makes the two bindings comparable.
 *
 * **This is the one fact not read from the route tree**, for the reasons in
 * the header. It is a declaration, and `assertUnwrapCoverage` below makes it
 * a checked one: an operation served by a route and missing here fails the
 * build rather than defaulting to a guess.
 */
export const UNWRAP = {
  // ── Single-item writes and reads: the route wraps under its noun ────
  create_item: "item",
  create_project: "item",
  create_task: "item",
  create_subtask: "item",
  get_item: "item",
  update_item: "item",
  retype_to_task: "item",
  reparent_item: "item",
  get_item_detail: "detail",
  get_project_detail: "detail",
  get_board: "board",
  get_item_body: null,
  get_item_history: null,
  get_events: null,
  // `complete_item` is the subtle one: the ROUTE passes the result through
  // plainly, but the OPERATION's result is itself `{ item }`, so the body is
  // `{ item }` and the key is real. The wrapper comes from the operation,
  // not from the route — which is exactly why this fact cannot be read off
  // the route's response expression.
  complete_item: "item",
  // Envelopes returned whole, because a key would discard the part the
  // caller most needs. `delete_item`'s `archived` distinguishes "this call
  // archived it" from "it already was"; `transition_item` answers two
  // different shapes for a real move and a rehearsal.
  delete_item: null,
  restore_item: null,
  transition_item: null,
  list_items: null,
  get_stale_candidates: null,
  search: null,
  get_projects: null,
  get_activity: null,
  get_costs: null,
  get_fleet: null,
  get_needs_you: null,
  poll: null,
  readiness: null,

  // ── Settings: every one returns its result unwrapped ────────────────
  get_settings: null,
  get_setting: null,
  put_setting: null,
  patch_settings: null,
  delete_setting: null,
  remove_unrecognised_setting: null,

  // ── Reference rows ──────────────────────────────────────────────────
  list_repos: null,
  get_repo: "repo",
  create_repo: "repo",
  update_repo: "repo",
  delete_repo: null,
  list_areas: null,
  get_area: "area",
  create_area: "area",
  update_area: "area",
  delete_area: null,
  merge_areas: null,
  list_machines: null,
  get_machine: "machine",
  update_machine: "machine",
  list_accounts: null,
  get_account: "account",
  update_account: "account",
  list_people: null,
  update_person: "person",
  delete_person: null,

  // ── Ownership ───────────────────────────────────────────────────────
  claim: "assignment",
  release: "assignment",
  heartbeat: "assignment",
  // Returned whole: a takeover carries how alive the holder was judged and
  // what has NOT been enforced, and a sweep is a report with four lists.
  takeover: null,
  sweep: null,
  checkpoint: "event",
  note: "event",
  orientation: null,
  my_work: null,
  progress_report: null,
  get_crew_name: "name",
  wait_for_crew: null,

  // ── Loops. The three writes answer multi-key envelopes ──────────────
  loop_add: null,
  loop_close: "event",
  loop_list: null,
  loop_get: null,
  loop_edit: null,
  loop_delete: null,

  // ── Artifacts, sessions, scoring, and the rest ──────────────────────
  record_artifact: "artifact",
  // `event`, not `reviewRequest`: the route answers the appended event.
  // This was declared wrong on the first pass and caught by
  // `tests/cli-artifact-verbs.test.ts`, which is the reason the declared
  // half of this map is worth having tests aimed at it.
  request_review: "event",
  register_session: "registration",
  get_session_detail: null,
  get_session_shape: null,
  list_runs: null,
  get_run_scores: null,
  score_run: null,
  derive_run_score: null,
  accept_run_score: null,
  score_intervention: null,
  record_intervention: null,
  get_intervention_scores: null,
  get_item_artifacts: null,
  report_blocked_on_tool: null,
  repair_stuck_projects: null,
  mark_event_seen: null,
  record_tool_calls: null,
  hook_decision: null,
  kill_guard: null,
  backfill: null,

  // The intervention catalogue's configuration surface, under
  // `/api/interventions/**` rather than `/api/settings/**` because these keys
  // are deliberately outside `SETTINGS_REGISTRY` and the settings routes
  // refuse them by design. All three answer their result unwrapped.
  list_intervention_settings: null,
  set_intervention_level: null,
  clear_intervention_level: null,
};

/** Every `route.ts` under the API tree, relative to it, sorted. */
function routeFiles(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) found.push(...routeFiles(full, relative));
    else if (entry === "route.ts") found.push(relative);
  }
  return found;
}

/**
 * Blanks comments while preserving every byte's position.
 *
 * Position-preserving because method attribution below is by offset: a
 * replacement that changed lengths would shift every call site past the
 * first comment and attribute it to the wrong handler.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/** A route file's path, as the URL it serves. Same conventions as the sibling generator. */
function urlPathFor(relative) {
  const segments = relative
    .split("/")
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .map((segment) => {
      if (segment.startsWith("[...") && segment.endsWith("]"))
        return `{${segment.slice(4, -1)}...}`;
      if (segment.startsWith("[") && segment.endsWith("]")) return `{${segment.slice(1, -1)}}`;
      return segment;
    });
  return `/api${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
}

/**
 * Reads which input field each path parameter carries, from the call's own
 * input expression.
 *
 * `{ ...body, id }` yields `{ id: "id" }` — the path's `id` travels as the
 * field `id`. `{ ...body, eventId: id }` yields `{ id: "eventId" }` — the
 * path's `id` travels as `eventId`. Only bindings naming a parameter the
 * path actually declares are kept, so a local variable that happens to share
 * a name cannot invent a path field.
 */
function pathFieldsFor(inputExpression, parameters) {
  const fields = {};
  // The surrounding braces are stripped first, so the first and last parts
  // are `...body` and `id` rather than `{ ...body` and `id }` — without
  // this every binding silently read as "no path fields", and the path
  // parameter would have been sent in the body instead.
  const inner = inputExpression.trim().replace(/^\{/, "").replace(/\}$/, "");
  // Split at TOP-LEVEL commas only. `register_session` passes
  // `{ ...(typeof body === "object" && body !== null ? body : {}), sessionId: id }`,
  // whose ternary contains commas and braces of its own; a naive split
  // shreds it into fragments that match nothing.
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of inner) {
    if ("({[".includes(character)) depth++;
    else if (")}]".includes(character)) depth--;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);

  for (const part of parts) {
    const trimmed = part.trim();
    const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (renamed && parameters.includes(renamed[2])) {
      fields[renamed[2]] = renamed[1];
      continue;
    }
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (shorthand && parameters.includes(shorthand[1])) fields[shorthand[1]] = shorthand[1];
  }
  return fields;
}

/**
 * Whether the call forwards a request body.
 *
 * `{ ...body, id }` does; `{ id }` does not. A route that reads no body is
 * addressed with none, so a `GET` stays a `GET` with no `Content-Type`.
 */
function sendsBody(inputExpression) {
  // A bare identifier (`service.call("create_item", body, ...)`) IS the
  // forwarded body — the route parsed the request into it and passes it
  // whole. Only an object literal with no spread reads nothing from the
  // request, which is the `{ id }` shape a path-only GET uses.
  if (!inputExpression.trim().startsWith("{")) return true;
  // ANY spread counts, not just a spread of a bare identifier.
  // `register_session` spreads a parenthesised ternary
  // (`...(typeof body === "object" ? body : {})`), and reading that as "no
  // body" would have dropped every field of a registration on the floor.
  return /\.\.\./.test(inputExpression);
}

/** Reads the whole route tree into one operation-keyed route map. */
export function collectCliRoutes() {
  const routes = [];
  for (const relative of routeFiles(API_ROOT)) {
    const source = withoutComments(readFileSync(path.join(API_ROOT, relative), "utf-8"));
    const url = urlPathFor(relative);
    const parameters = [...url.matchAll(/\{(\w+?)(?:\.\.\.)?\}/g)].map((match) => match[1]);

    // Handler boundaries, so a call is attributed to the method it is
    // lexically inside rather than to whichever export happens to be near.
    const marks = [];
    for (const match of source.matchAll(
      new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METHODS.join("|")})\\b`, "g"),
    ))
      marks.push({ at: match.index, method: match[1] });
    for (const match of source.matchAll(
      new RegExp(`export\\s+(?:const|let|var)\\s+(${METHODS.join("|")})\\s*=`, "g"),
    ))
      marks.push({ at: match.index, method: match[1] });
    marks.sort((a, b) => a.at - b.at);

    for (let index = 0; index < marks.length; index++) {
      const block = source.slice(
        marks[index].at,
        index + 1 < marks.length ? marks[index + 1].at : source.length,
      );
      // The input argument is either an object literal (`{ ...body, id }`)
      // or a bare identifier (`body`, `input`) — both are common here, and
      // a matcher demanding braces silently collected only half the tree.
      const call = /service\.call\(\s*"([a-z_]+)"\s*,\s*(\{[^;]*?\}|[A-Za-z_$][\w$]*)\s*,/.exec(
        block,
      );
      if (!call) continue;

      // When the input is a bare identifier the binding lives in that
      // variable's initialiser one or two lines up — `const input: Record<…>
      // = { id };` — so it is followed rather than given up on. Not
      // following it silently produced "no path fields" for every read-shaped
      // route, which would have sent the path id in the body instead.
      let expression = call[2];
      if (!expression.trim().startsWith("{")) {
        const declaration = new RegExp(
          `(?:const|let|var)\\s+${expression.trim()}\\b[^=]*=\\s*(\\{[^;]*?\\})\\s*;`,
        ).exec(block);
        if (declaration) expression = declaration[1];
      }

      // Fields a BODY-CARRYING route nonetheless reads from the query
      // string. `transition_item` is the case: it reads `?dry_run=true`
      // while taking everything else as a body, and sending that flag in the
      // body instead means a rehearsal silently becomes a real move — the
      // most expensive possible way to get this wrong. Derived from the
      // route's own `searchParams.get("...")` calls, paired with the input
      // field of the same name in camelCase, so it covers any future route
      // that does the same rather than special-casing this one.
      const queryFields = {};
      if (marks[index].method !== "GET") {
        for (const read of block.matchAll(/searchParams\.get\("([a-z_]+)"\)/g)) {
          const parameter = read[1];
          const field = parameter.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
          if (new RegExp(`\\b${field}\\b`).test(expression)) queryFields[field] = parameter;
        }
      }

      routes.push({
        operation: call[1],
        method: marks[index].method,
        path: url,
        queryFields,
        pathFields: pathFieldsFor(expression, parameters),
        // A `GET` never carries a body — whatever it does not put in the
        // path goes in the query string. Reading this off the input
        // expression alone would have marked every read-shaped route as
        // body-carrying, because their inputs are assembled from the query.
        sendsBody: marks[index].method !== "GET" && sendsBody(call[2]),
      });
    }
  }

  // An operation reached from two routes would make "which route addresses
  // this operation" ambiguous, and the binding is keyed on the operation
  // name. Measured as zero across all 93 call sites when this was written;
  // asserted so that it staying zero is a fact rather than an assumption.
  const seen = new Map();
  for (const route of routes) {
    const previous = seen.get(route.operation);
    if (previous) {
      throw new Error(
        `\`${route.operation}\` is called from two routes — ${previous.method} ${previous.path} ` +
          `and ${route.method} ${route.path}. The \`http\` binding is keyed on the operation ` +
          `name, so one of them has to be the route it addresses. Split the operation, or give ` +
          `the second route its own.`,
      );
    }
    seen.set(route.operation, route);
  }

  return routes.sort((a, b) => a.operation.localeCompare(b.operation));
}

/**
 * Fails when `UNWRAP` and the route tree disagree about which operations
 * exist.
 *
 * Both directions matter and they fail for different reasons: an operation
 * served but undeclared would be generated with no way to read its result,
 * and a declaration naming no route is a line nobody will ever delete
 * because nothing says it is dead.
 */
export function assertUnwrapCoverage(routes) {
  const served = routes.map((route) => route.operation);
  const undeclared = served.filter((operation) => !(operation in UNWRAP));
  const orphaned = Object.keys(UNWRAP).filter((operation) => !served.includes(operation));

  if (undeclared.length > 0 || orphaned.length > 0) {
    const lines = [];
    if (undeclared.length > 0) {
      lines.push(
        `These operations are served by a route but have no entry in \`UNWRAP\`:`,
        ...undeclared.map((operation) => `  ${operation}`),
        `Add each one, with the response key its route wraps the result under, or \`null\` if the body is the result.`,
      );
    }
    if (orphaned.length > 0) {
      lines.push(
        `These \`UNWRAP\` entries name an operation no route serves:`,
        ...orphaned.map((operation) => `  ${operation}`),
        `Delete each one, or add the route it is waiting for.`,
      );
    }
    throw new Error(lines.join("\n"));
  }
}

/** The exact text of the generated module. */
export function render(routes) {
  const entries = routes
    .map((route) => {
      const unwrap = UNWRAP[route.operation];
      const query = Object.entries(route.queryFields)
        .map(([field, parameter]) => `${field}: ${JSON.stringify(parameter)}`)
        .join(", ");
      const fields = Object.entries(route.pathFields)
        // Unquoted keys and one entry per line, because that is what
        // Prettier produces for this shape. The generated file is checked by
        // `format:check` like any other, so emitting anything else means
        // `npm run format` rewrites it and `check:cli-routes` then reports
        // it stale — two green-looking gates that cannot both pass.
        .map(([parameter, field]) => `${parameter}: ${JSON.stringify(field)}`)
        .join(", ");
      return [
        `  ${route.operation}: {`,
        `    method: ${JSON.stringify(route.method)},`,
        `    path: ${JSON.stringify(route.path)},`,
        `    pathFields: {${fields.length > 0 ? ` ${fields} ` : ""}},`,
        `    queryFields: {${query.length > 0 ? ` ${query} ` : ""}},`,
        `    sendsBody: ${route.sendsBody},`,
        `    unwrapKey: ${unwrap === null || unwrap === undefined ? "null" : JSON.stringify(unwrap)},`,
        `  },`,
      ].join("\n");
    })
    .join("\n");

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Written by \`scripts/generate-cli-routes.mjs\` from the route tree under
// \`src/app/api\`. Run \`npm run generate:cli-routes\` after adding, moving or
// removing a route; \`npm run check:cli-routes\` fails in CI when this file
// and the route tree disagree, which is what keeps it honest.
//
// This is how the command line's \`http\` binding addresses each operation.
// It replaced 68 hand-written \`RouteSpec\` entries across eight files, which
// were a second copy of facts the routes already declared. See the generator
// for why the unwrap key is declared there rather than inferred here.

/** How one operation is addressed over HTTP. */
export interface GeneratedRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The URL template, with \`{param}\` for each path parameter. */
  readonly path: string;
  /** Which operation input field each path parameter carries. */
  readonly pathFields: Readonly<Record<string, string>>;
  /**
   * Input fields a body-carrying route reads from the QUERY STRING instead.
   *
   * Keyed by input field, valued by the query parameter's spelling —
   * \`transition_item\`'s \`dryRun\` travels as \`?dry_run=\`. Sending one of
   * these in the body means the route never sees it, which for a rehearsal
   * flag turns a dry run into a real move.
   */
  readonly queryFields: Readonly<Record<string, string>>;
  /** Whether the route reads a request body. */
  readonly sendsBody: boolean;
  /** The response key holding the result, or \`null\` when the body is it. */
  readonly unwrapKey: string | null;
}

/** Every operation the web API serves, by the name the service knows it as. */
export const GENERATED_ROUTES: Readonly<Record<string, GeneratedRoute>> = Object.freeze({
${entries}
});
`;
}

function main() {
  const routes = collectCliRoutes();
  assertUnwrapCoverage(routes);
  const text = render(routes);

  if (process.argv.includes("--check")) {
    const existing = readFileSync(OUTPUT, "utf-8");
    if (existing !== text) {
      console.error(
        `${path.relative(REPO_ROOT, OUTPUT)} is out of date with the route tree.\n` +
          `Run \`npm run generate:cli-routes\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`${path.relative(REPO_ROOT, OUTPUT)} is up to date (${routes.length} operations).`);
    return;
  }

  writeFileSync(OUTPUT, text);
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT)} (${routes.length} operations).`);
}

// Compared through `pathToFileURL` rather than by string-building a
// `file://` URL: on Windows the latter yields `file://C:/...`, which reads
// `C:` as a HOST and never equals `import.meta.url`'s `file:///C:/...`. The
// script then exported its functions and silently did nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
