// Row #89 (MILESTONES.md): the npm package ships the `standup` binary on the
// same version tag that publishes the image. These tests exercise the built
// artefact the way a real install would use it — never the TypeScript
// source, never anything only true "in theory" — because the failure mode
// this row exists to prevent (a broken or half-shipped binary) is exactly
// the kind of thing that looks fine in source and only breaks once built
// and packed.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const entryPath = "dist/bin/standup.js"; // the literal contract: package.json "bin.standup"
const hookEntryPath = "dist/bin/standup-hook.js"; // likewise, "bin.standup-hook"

function runBuiltCli(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [entryPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

// `dist/` is built once for the whole run by `tests/helpers/global-setup.ts`,
// which is the only writer — see the note there for why a per-file build races.

describe("package.json publish contract", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  it("publishes both binaries at their literal built paths", () => {
    // Two entries, and the second is not an afterthought. `standup-hook` is
    // the entry point an agent tool is wired to (MILESTONES.md #48), and a
    // bare command name is the only address that resolves on a machine whose
    // layout the wiring does not choose. It cannot be served by `standup`
    // instead: that entry point supplies no stdin (`src/bin/standup.ts`), so
    // a hook routed through it reads an empty payload and allows — an
    // install that reports healthy and enforces nothing.
    expect(pkg.bin).toEqual({ standup: entryPath, "standup-hook": hookEntryPath });
  });

  it("is publishable (not marked private)", () => {
    expect(pkg.private).toBe(false);
  });

  it("ships the whole dist/ directory, not just dist/bin", () => {
    // Code splitting (scripts/build-cli.mjs) puts shared/lazy chunks at the
    // dist/ root, alongside dist/bin/. A files list scoped to only
    // "dist/bin" would silently drop those chunks from the published
    // tarball — the built entry would `import` a file that does not exist
    // in the installed package. This is a real regression this suite
    // caught once already, not a hypothetical.
    expect(pkg.files).toEqual(["dist"]);
  });
});

describe("bin resolution — the built entry point actually runs", () => {
  it("built dist/bin/standup.js exists with a node shebang", () => {
    expect(existsSync(path.join(repoRoot, entryPath))).toBe(true);
    const firstLine = readFileSync(path.join(repoRoot, entryPath), "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("`standup --help` runs and exits 0 with no configuration at all", () => {
    // --json, because without it human text goes to stderr and stdout gets
    // nothing at all for a success outcome (src/lib/cli/render.ts) — this
    // is the documented contract, not an incidental detail of this test.
    const result = runBuiltCli(["--help", "--json"], {
      DATABASE_URL: "",
      STANDUP_URL: "",
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.usage).toContain("standup <noun> <verb>");
  });

  it("`standup doctor` runs from the built artefact without a database", () => {
    const result = runBuiltCli(["doctor", "--json"], { DATABASE_URL: "", STANDUP_URL: "" });
    // Exit code 4 (EXIT.UNCONFIGURED per src/lib/cli/envelope.ts) is the
    // real, correct answer for an unconfigured install — not a crash, and
    // not a silent success. A build that broke module resolution for this
    // command would throw before ever reaching a JSON envelope.
    expect(result.status).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.configured).toBe(false);
  });
});

describe("the entry point defers the database client (real code splitting, not just no crash)", () => {
  it("the built entry file contains no static reference to @prisma/client", () => {
    // src/lib/cli/run.ts loads the composition root with a genuine dynamic
    // `import()`, only for the `direct` binding — see its own header
    // comment. A bundler that flattens everything into one file hoists
    // every import to the top, turning that lazy load back into an eager
    // one: `standup --help` would then need @prisma/client just to print
    // help text. This is what would break if scripts/build-cli.mjs ever
    // stopped code-splitting (e.g. `splitting: true` flipped to `false`) —
    // confirmed by actually flipping it during this row's work: the
    // string appears in the entry file the moment splitting is off.
    const entry = readFileSync(path.join(repoRoot, entryPath), "utf8");
    expect(entry).not.toContain("@prisma/client");
  });

  it("@prisma/client is real in the build — deferred, not silently dropped", () => {
    // The assertion above alone can't tell "correctly split" apart from
    // "accidentally deleted the code path". This proves the reference
    // still exists somewhere in the built output, just not in the entry
    // file that always runs.
    const distDir = path.join(repoRoot, "dist");
    const files = ["bin/standup.js"]
      .concat(
        // every other file directly under dist/ — the shared and lazy chunks
        readdirSync(distDir).filter((name) => name.endsWith(".js")),
      )
      .map((name) => path.join(distDir, name));
    const anyChunkHasPrisma = files.some((file) =>
      readFileSync(file, "utf8").includes("@prisma/client"),
    );
    expect(anyChunkHasPrisma).toBe(true);
  });
});

describe("npm pack — what actually ships", () => {
  // `npm pack` spawns real child processes, which is slower than the 5s
  // default test timeout.
  const NPM_PACK_TIMEOUT_MS = 20_000;

  it(
    "includes the built binary and its chunks, excludes source and app code",
    () => {
      // execSync, not execFileSync: npm's own launcher is a .cmd shim on
      // Windows, which node can only spawn through a shell. execSync always
      // goes through one; the command below is a fixed literal, nothing
      // interpolated into it.
      //
      // **`--ignore-scripts` is load-bearing, not a speed-up.** Without it
      // `npm pack` runs `prepack`, which is `build:cli`, which opens by
      // deleting `dist/` wholesale. `dist/` is built once for the whole run
      // by `tests/helpers/global-setup.ts` precisely so there is a single
      // writer, and vitest runs this file in a worker parallel with
      // `tests/hook-built-script.test.ts`, which spawns `dist/bin/
      // standup-hook.js` as a process. A rebuild here reopens exactly the
      // delete-then-write window that having one writer closed: the hook
      // binary is spawned while its chunk is missing, crashes, and exits 1
      // where the test expects a deny's 2 — a failure in a file this one
      // never mentions, on whichever assertion happened to land inside the
      // window.
      //
      // Nothing is lost by skipping it. This test asks which *files* the
      // package would ship, which `package.json`'s `files` list decides;
      // `dist/` is already built and present, so the answer is the same one
      // a rebuild would produce.
      const output = execSync("npm pack --dry-run --json --ignore-scripts", {
        cwd: repoRoot,
        encoding: "utf8",
      });
      // `npm pack` writes non-JSON progress lines (prepack/prepare script
      // output) before the JSON array — only the array itself is parsed.
      const jsonStart = output.indexOf("[");
      const parsed = JSON.parse(output.slice(jsonStart));
      const files: string[] = parsed[0].files.map((f: { path: string }) =>
        f.path.replace(/\\/g, "/"),
      );

      expect(files).toContain(entryPath);
      expect(files.some((f) => f.startsWith("dist/") && f !== entryPath)).toBe(true);

      for (const f of files) {
        expect(f.startsWith("src/")).toBe(false);
        expect(f.startsWith("prisma/")).toBe(false);
        expect(f.startsWith("tests/")).toBe(false);
      }
    },
    NPM_PACK_TIMEOUT_MS,
  );

  it("never lets its own `npm pack` rebuild dist/ from under a parallel worker", () => {
    // MILESTONES.md #127(b). The comment above explains why
    // `--ignore-scripts` is load-bearing; this asserts it, because a comment
    // cannot fail. Dropping the flag reinstates a `prepack` that deletes
    // `dist/` while `tests/hook-built-script.test.ts` is spawning a binary
    // out of it — and the resulting failure lands in *that* file, on
    // whichever assertion happened to fall inside the window, naming nothing
    // that would lead anyone back to this line.
    //
    // Read from this file's own source rather than parameterised into the
    // call above: the thing worth pinning is that the command this test
    // actually runs carries the flag, which a variable shared between the
    // two would assert about itself.
    const source = readFileSync(path.join(repoRoot, "tests/cli-package-publish.test.ts"), "utf8");
    const packInvocations = source.match(/execSync\(\s*"npm pack[^"]*"/g) ?? [];

    // Guards the guard — a renamed call would otherwise make this vacuous.
    expect(packInvocations.length).toBeGreaterThan(0);
    for (const invocation of packInvocations) {
      expect(invocation).toContain("--ignore-scripts");
    }
  });
});
