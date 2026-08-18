// Structural proof that no front-end module calls the API directly.
//
// The per-module behaviour is tested where each fetcher lives. This file
// asserts the property that makes the fix hold for code written after it:
// that every front-end request path goes through `uiApiPath`, including the
// twenty-first call site nobody was thinking about.
//
// The failure this exists to catch is quiet and reaches a person rather than
// a test — a new screen writes `fetch("/api/thing")` because that is the
// path the documentation names, it works in every unit test (which injects
// its own `fetch`), and it 401s in a real browser on that screen only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { uiApiPath, UI_API_PREFIX } from "@/lib/ui-proxy/path";

/** The real, git-tracked repo root — see `auth-route-coverage.test.ts`. */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();

/**
 * The directories whose code runs in a browser: the client components and
 * the pure state modules they wire together.
 *
 * `src/lib/cli/`, `src/lib/hook/` and `src/lib/task-shim/` are deliberately
 * outside this scan. They are the *machine* clients — a command line and a
 * session hook running on a host that holds its own token — and they must
 * keep calling the API directly with it. Routing them through the front
 * end's forwarding path would make every remote client depend on a browser
 * credential being configured, which is backwards.
 */
const SCANNED_DIRS = ["src/components", "src/lib"] as const;

/**
 * Modules under `src/lib` that are machine clients or the forwarding
 * machinery itself, and so legitimately name an `/api/` path.
 *
 * Listed exactly, and asserted to stay this length, for the reason the
 * unauthenticated-route allowlist is: an exemption list that grows silently
 * is a check that can be switched off by adding a file.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "src/lib/ui-proxy/path.ts",
    "Defines the prefix. It is the module every other front-end path is routed through.",
  ],
  [
    "src/lib/ui-proxy/forward.ts",
    "The forwarding route's own logic: it builds the API URL that the browser's call is " +
      "rewritten to, so naming the destination is its entire job.",
  ],
  [
    "src/lib/admin/kinds.ts",
    "Declares each administrable kind's collection endpoint as data. Nothing here fetches: " +
      "`src/lib/admin/state.ts` is the only reader of `listPath` and wraps every use in " +
      "`uiApiPath`, which is asserted directly below rather than left to this exemption.",
  ],
  [
    "src/lib/service/operations/register-session.ts",
    "Runs on the server and returns a URL for a *session* to fetch with its own machine " +
      "token during registration — not a path any browser code calls.",
  ],
]);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

const MACHINE_CLIENT_PREFIXES = ["src/lib/cli/", "src/lib/hook/", "src/lib/task-shim/"];

function toRepoRelative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

const FRONT_END_FILES = SCANNED_DIRS.flatMap((dir) => walk(path.resolve(REPO_ROOT, dir)))
  .map(toRepoRelative)
  .filter((relative) => !MACHINE_CLIENT_PREFIXES.some((prefix) => relative.startsWith(prefix)))
  .filter((relative) => !ALLOWED.has(relative));

/** Blanks comments while preserving length — see `auth-route-coverage.test.ts`. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

describe("uiApiPath", () => {
  it("rewrites an API path onto the forwarding prefix", () => {
    expect(uiApiPath("/api/people")).toBe("/api/ui/people");
    expect(uiApiPath("/api/board?column=waiting")).toBe("/api/ui/board?column=waiting");
  });

  it("is idempotent, so composing two helpers cannot double the prefix", () => {
    expect(uiApiPath(uiApiPath("/api/people"))).toBe("/api/ui/people");
  });

  it("leaves an unrelated path alone rather than prefixing it", () => {
    expect(uiApiPath("/settings")).toBe("/settings");
    expect(uiApiPath("/apiary/bees")).toBe("/apiary/bees");
  });

  it("does not re-encode an already-encoded segment", () => {
    // Callers encode ids themselves; encoding again would turn `a%2Fb` into
    // `a%252Fb` and ask the API for an item that does not exist.
    expect(uiApiPath("/api/items/a%2Fb/detail")).toBe("/api/ui/items/a%2Fb/detail");
  });

  it("agrees with the route the forwarding handler is mounted at", () => {
    expect(UI_API_PREFIX).toBe("/api/ui");
  });
});

describe("no front-end module calls the API directly", () => {
  it("finds front-end files at all", () => {
    // A scanner that silently found nothing would pass by vacuous truth.
    expect(FRONT_END_FILES.length).toBeGreaterThan(50);
  });

  it("scans the modules that actually do the fetching", () => {
    // Names the files this check exists for, so a refactor that moved or
    // renamed them cannot leave the scan pointing at nothing.
    expect(FRONT_END_FILES).toContain("src/lib/profile/state.ts");
    expect(FRONT_END_FILES).toContain("src/lib/board/state.ts");
    expect(FRONT_END_FILES).toContain("src/lib/admin/state.ts");
  });

  it.each(FRONT_END_FILES)("%s routes every /api/ path through uiApiPath", (relative) => {
    const source = withoutComments(readFileSync(path.resolve(REPO_ROOT, relative), "utf-8"));

    // An `/api/…` path literal is fine — it is what the documentation and
    // the route tree call the endpoint, and rewriting the prose form at
    // every call site is exactly the duplication `uiApiPath` removes. What
    // must not happen is one reaching `fetch` unwrapped. So each literal is
    // required to sit inside a `uiApiPath(` call, which is checked by
    // matching the wrapper and its argument together rather than by
    // forbidding the literal.
    const literals = source.match(/["'`]\/api\//g) ?? [];
    if (literals.length === 0) return;

    // `uiApiPath(` followed by an optional interpolation prefix and then the
    // literal — covers `uiApiPath("/api/people")`, `` uiApiPath(`/api/x/${id}`) ``
    // and `uiApiPath(`${kind.listPath}${query}`)`'s sibling forms.
    const wrapped = source.match(/uiApiPath\(\s*["'`]\/api\//g) ?? [];
    expect(
      wrapped.length,
      `${relative} names an /api/ path outside uiApiPath(). Front-end code must call ` +
        `uiApiPath("/api/…") so the request is forwarded with the server's credential ` +
        `instead of arriving at the API with none.`,
    ).toBe(literals.length);
  });

  it("wraps every use of an admin kind's declared listPath", () => {
    // `src/lib/admin/kinds.ts` is exempted above because it declares
    // endpoints as data rather than fetching them. That exemption is only
    // honest if the module that *does* fetch them wraps every use — so
    // this asserts it, and the exemption stops being a hole.
    const source = withoutComments(
      readFileSync(path.resolve(REPO_ROOT, "src/lib/admin/state.ts"), "utf-8"),
    );
    const uses = source.match(/kind\.listPath/g) ?? [];
    expect(uses.length, "admin/state.ts should still read listPath").toBeGreaterThan(0);

    const unwrapped = uses.length - (source.match(/uiApiPath\([^)]*kind\.listPath/g) ?? []).length;
    expect(
      unwrapped,
      "every kind.listPath read in admin/state.ts must be wrapped in uiApiPath()",
    ).toBe(0);
  });

  it("holds the allowlist to exactly the modules argued for", () => {
    expect([...ALLOWED.keys()].sort()).toEqual(
      [
        "src/lib/admin/kinds.ts",
        "src/lib/service/operations/register-session.ts",
        "src/lib/ui-proxy/forward.ts",
        "src/lib/ui-proxy/path.ts",
      ].sort(),
    );
  });

  it("every allowlisted module carries a real reason and exists", () => {
    for (const [relative, reason] of ALLOWED) {
      expect(reason.length, `${relative} needs a reason worth reading`).toBeGreaterThan(60);
      expect(
        () => statSync(path.resolve(REPO_ROOT, relative)),
        `${relative} is listed but not on disk`,
      ).not.toThrow();
    }
  });
});
