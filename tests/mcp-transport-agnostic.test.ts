// The MCP core is transport-agnostic (MILESTONES.md #30), which is the
// precondition for #84 wiring the same core to stdio without touching a
// handler.
//
// Asserted **structurally**, against the core's real import graph, rather
// than by exercising behaviour. That choice is deliberate: a behavioural
// test can only show that the core works over the transports it was handed,
// and "works over two transports" is not the claim. The claim is that the
// core cannot depend on one — a negative, about code that is absent — and
// the only way to check an absence is to look.
//
// So this walks the core's imports transitively, from the module a
// consumer enters at, and requires that no HTTP-specific module appears
// anywhere in the closure. If someone imports `Request` into a handler for
// convenience, #84 becomes a rewrite instead of a wiring change, and this
// test is what says so at the time it happens rather than months later.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 * See `tests/service-registry.test.ts`'s `repoRoot()` for the full
 * rationale: under mutation testing Stryker runs the suite from a sandboxed,
 * instrumented copy of the tree, and a scan rooted on `import.meta.dirname`
 * would read that rewritten copy instead of the real source.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const ROOT = repoRoot();

/** The core's entry point — what `./index.ts` re-exports and #84 will import. */
const CORE_ENTRY = "src/lib/mcp/server.ts";

/** Every module in `src/lib/mcp/`, so a new one cannot be added unscanned. */
const CORE_DIR = "src/lib/mcp";

/**
 * The wiring that is *allowed* to know about HTTP — this row's own
 * deliverable, and the file #84 will sit beside rather than inside.
 */
const HTTP_WIRING = "src/lib/mcp/http.ts";

/**
 * Module specifiers that mean "this file knows how bytes arrive".
 *
 * Two families, and each is a real way the dependency could be introduced:
 * an SDK transport module, or a server framework's request/response types.
 * This is a fixed list of known shapes, so — exactly as
 * `check-external-refs.mjs`'s header says of itself — **a green result
 * means none of these appear, not that no HTTP dependency of any kind
 * could ever be introduced.** A transport reached through a specifier
 * spelled in a way this list does not anticipate would not be caught here;
 * what stops that in practice is that the SDK's transports all live under
 * `server/`/`client/` with a transport-shaped name, which is what the two
 * patterns below match.
 */
const HTTP_SPECIFIER_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /streamablehttp|streamable-http|\/server\/sse\.js|\/server\/express\.js/i,
    why: "an MCP SDK HTTP transport",
  },
  {
    pattern: /^next\/|^express$|^node:http$|^node:https$|^node:net$/i,
    why: "a server framework or socket module",
  },
];

/**
 * Identifiers that only exist because a transport does.
 *
 * Matched as whole words in the source, not as substrings — `Request` must
 * not fire on `RequestHandlerExtra`, and `Response` must not fire on
 * `ResponseShape`, or the check would be noise rather than a signal.
 */
const HTTP_IDENTIFIER_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bNextResponse\b/, why: "a Next.js response" },
  { pattern: /\bIncomingMessage\b|\bServerResponse\b/, why: "a Node HTTP message" },
  { pattern: /\bReadableStream\b|\bHeaders\b/, why: "a streaming/HTTP primitive" },
];

/** Read one repo-relative TypeScript file. */
function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf-8");
}

/**
 * The same file with comments removed.
 *
 * The identifier scan has to run over code, not prose. `server.ts`'s own
 * header states what it must not contain — and names `IncomingMessage`,
 * `Headers` and the rest in order to state it — so a scan that read
 * comments would flag the very documentation of the rule it is enforcing.
 * Stripping is deliberately naive (it does not understand a `//` inside a
 * string literal), which is safe here in the direction that matters: the
 * worst it can do is leave *more* text in scope, never less, so it cannot
 * hide a real occurrence.
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every import specifier in a file, in source order. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import[^;]*?from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  // Bare side-effect imports (`import "./x"`) count too — a module that
  // runs for its side effect is still in the graph.
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolve `./x`, `../x` and `@/x` to a repo-relative `.ts` path, or null for a package. */
function resolveLocal(specifier: string, importer: string): string | null {
  let resolved: string;
  if (specifier.startsWith("@/")) {
    resolved = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  } else {
    return null;
  }
  const withoutExtension = resolved.replace(/\.(ts|tsx|js)$/, "");
  for (const candidate of [`${withoutExtension}.ts`, `${withoutExtension}/index.ts`]) {
    try {
      readFileSync(path.join(ROOT, candidate), "utf-8");
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Every local module reachable from `entry`, plus every package specifier
 * anything in that closure imports.
 */
function transitiveClosure(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages: string[] = [];
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    files.push(current);

    for (const specifier of importSpecifiers(readCode(current))) {
      const local = resolveLocal(specifier, current);
      if (local) {
        queue.push(local);
      } else {
        packages.push(specifier);
      }
    }
  }

  return { files, packages };
}

/**
 * Every `.ts` file under `src/lib/mcp/`.
 *
 * Read from the directory rather than from `git ls-files`, so a core module
 * that has been written but not yet staged is covered by the same scan. A
 * check that only saw committed files would let the very change that
 * introduces the dependency pass locally and fail only after it landed.
 */
function coreDirFiles(): string[] {
  return readdirSync(path.join(ROOT, CORE_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${CORE_DIR}/${entry.name}`)
    .sort();
}

describe("the MCP core does not assume HTTP", () => {
  it("scans a non-empty import closure", () => {
    // A scan that found nothing would make every assertion below vacuously
    // true — the same reasoning `check-db-import-allowlist.mjs` gives for
    // failing on an empty file list rather than passing.
    const { files, packages } = transitiveClosure(CORE_ENTRY);
    expect(files).toContain(CORE_ENTRY);
    expect(files.length).toBeGreaterThan(1);
    expect(packages.length).toBeGreaterThan(0);
  });

  it("reaches no HTTP transport module, transitively, from the core entry", () => {
    const { files, packages } = transitiveClosure(CORE_ENTRY);
    // The wiring is what this is proving the core is free of — its
    // presence in the closure would be the failure, not an exemption.
    expect(files).not.toContain(HTTP_WIRING);

    const offenders: string[] = [];
    for (const specifier of packages) {
      for (const { pattern, why } of HTTP_SPECIFIER_PATTERNS) {
        if (pattern.test(specifier)) offenders.push(`${specifier} (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no HTTP type in any file of the core's closure", () => {
    const { files } = transitiveClosure(CORE_ENTRY);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readCode(file);
      for (const { pattern, why } of HTTP_IDENTIFIER_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${file}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches an HTTP dependency planted in the core — the check can fail", () => {
    // Proves the scan is not passing because it looks at nothing. The two
    // assertions above are absences, and an absence check that has never
    // been shown to fire is indistinguishable from a no-op.
    const planted = `import { NextResponse } from "next/server";\nexport const x = NextResponse;\n`;
    const specifierOffenders = importSpecifiers(planted).filter((specifier) =>
      HTTP_SPECIFIER_PATTERNS.some(({ pattern }) => pattern.test(specifier)),
    );
    expect(specifierOffenders).toEqual(["next/server"]);
    expect(HTTP_IDENTIFIER_PATTERNS.some(({ pattern }) => pattern.test(planted))).toBe(true);
  });

  it("confirms the HTTP wiring genuinely is the file that knows about HTTP", () => {
    // The other side of the same claim: if `http.ts` did not itself import
    // a transport, "the core imports no transport" would be true for an
    // uninteresting reason — nothing anywhere would.
    const { packages } = transitiveClosure(HTTP_WIRING);
    const httpSpecifiers = packages.filter((specifier) =>
      HTTP_SPECIFIER_PATTERNS.some(({ pattern }) => pattern.test(specifier)),
    );
    expect(httpSpecifiers.length).toBeGreaterThan(0);
  });

  it("holds for every module in src/lib/mcp/ except the HTTP wiring", () => {
    // Scanning the entry's closure alone would miss a new core module that
    // nothing imports yet. Enumerating the directory means a file added
    // beside the core is covered the moment it is tracked.
    const files = coreDirFiles();
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain(HTTP_WIRING);

    const offenders: string[] = [];
    for (const file of files) {
      if (file === HTTP_WIRING) continue;
      const source = readCode(file);
      for (const specifier of importSpecifiers(source)) {
        for (const { pattern, why } of HTTP_SPECIFIER_PATTERNS) {
          if (pattern.test(specifier)) offenders.push(`${file} imports ${specifier} (${why})`);
        }
      }
      for (const { pattern, why } of HTTP_IDENTIFIER_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${file} names ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the same core is what a second transport would wire", () => {
  it("exposes the transport name as a parameter, not a decision the core makes", () => {
    // The one thing that genuinely differs between #30's binding and #84's
    // is the transport stamp. If the core chose it — a literal, or a
    // branch on how it was reached — #84 would have to edit the core. It
    // is a required option instead, which is why the stdio wiring can pass
    // `mcp-stdio` and change nothing else.
    const source = read(CORE_ENTRY);
    expect(source).toMatch(/readonly transport: string/);
    // And the core must not contain either transport's own name — a
    // default would let one binding be the implicit one.
    expect(source).not.toMatch(/["']mcp-http["']|["']mcp-stdio["']/);
  });
});
