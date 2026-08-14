import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS, deliberately: this has to run as `node scripts/check-event-emitters.mjs`
// with no build step, so CI can gate on it before anything is compiled. Types are
// inferred by `allowJs`, which is why the shapes below are asserted rather than typed.
import {
  EMITTER_ROOTS,
  KNOWN_UNEMITTED,
  NON_EMITTER_PATHS,
  SCHEMA_PATH,
  analyse,
  emitterFiles,
  findPropertyWrites,
  findSqlWrites,
  parseEventTypes,
} from "../scripts/check-event-emitters.mjs";

type Write = { type: string; line: number; kind: string };

const properties = (text: string): Write[] => findPropertyWrites(text) as Write[];
const sql = (text: string): Write[] => findSqlWrites(text) as Write[];
const propertyTypes = (text: string) => properties(text).map((w) => w.type);
const sqlTypes = (text: string) => sql(text).map((w) => w.type);

const scriptPath = path.resolve(import.meta.dirname, "../scripts/check-event-emitters.mjs");
const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Run the checker as CI runs it — a real process, over a real tree — and hand
 * back the exit code plus both streams. The unit tests below cover matching;
 * this covers the thing that actually gates a build.
 */
function runCli(cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
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

const tempDirs: string[] = [];

/**
 * Run the real checker binary *inside* a seeded tree.
 *
 * The script resolves its root from its own location, so pointing it at a
 * fixture means copying it in and running the copy. Exercising the CLI rather
 * than only `analyse` is what proves the exit code moves: an analyser that
 * found a fault while the binary exited 0 would gate nothing.
 */
function runCliIn(dir: string) {
  const seededScript = path.join(dir, "scripts", "check-event-emitters.mjs");
  mkdirSync(path.dirname(seededScript), { recursive: true });
  writeFileSync(
    seededScript,
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require("fs").readFileSync(${JSON.stringify(scriptPath)}, "utf8"))`,
      ],
      { encoding: "utf8" },
    ),
    "utf8",
  );

  try {
    const stdout = execFileSync(process.execPath, [seededScript], { cwd: dir, encoding: "utf8" });
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

/**
 * Build a miniature repository: a `prisma/schema.prisma` declaring an
 * `EventType` enum, and a `src/` tree of emitter files. The script resolves
 * its root from its own location, so a seeded tree is exercised through
 * `analyse(root)` rather than by running the binary in it — except for the
 * one CLI test below, which runs against this repository itself.
 */
function seedTree(enumValues: string[], files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "event-emitters-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "prisma"), { recursive: true });
  writeFileSync(
    path.join(dir, SCHEMA_PATH),
    `enum ActorType {\n  person\n  agent\n}\n\nenum EventType {\n${enumValues
      .map((v) => `  ${v}`)
      .join("\n")}\n}\n`,
    "utf8",
  );
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-event-emitters — it fails on a seeded violation", () => {
  // The reason this file exists. A gate proven only to pass on clean input has
  // never been run against the thing it was built to catch, and is a no-op with
  // a green checkmark beside it.

  it("fails when a declared event type has no writer anywhere", () => {
    const dir = seedTree(["note", "phantom_event"], {
      "src/lib/service/operations/note.ts": `
          await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
        `,
    });

    const result = analyse(dir);

    expect(result.unemitted).toEqual(["phantom_event"]);
    expect(result.emitters.has("note")).toBe(true);
  });

  it("passes the moment that same type gains a writer — the fix actually clears it", () => {
    // The negative control for the test above. Without this, a check that
    // always reported `phantom_event` as unemitted (say, one that ignored
    // emitters entirely) would satisfy the seeded-violation test perfectly.
    const dir = seedTree(["note", "phantom_event"], {
      "src/lib/service/operations/note.ts": `
          await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
        `,
      "src/lib/service/operations/phantom.ts": `
          await appendEvent(ctx.db, { itemId, type: "phantom_event", payload: {} });
        `,
    });

    expect(analyse(dir).unemitted).toEqual([]);
  });

  it("fails when the only mention of a type is a read, not a write", () => {
    // The heart of the check, and the defect that motivated it. A read path is
    // exactly what gets built first: a `WHERE type IN (...)` clause makes the
    // string present in the tree while nothing produces one. A gate that
    // grepped for the bare string would pass here — green, on the precise
    // absence it exists to catch.
    // Named `read_only_loop` rather than the real `open_loop`, deliberately:
    // `open_loop` carries a waiver in the live KNOWN_UNEMITTED list, so it
    // would be reported as waived and this assertion would pass for the wrong
    // reason. An unwaived name proves the read/write distinction itself.
    const dir = seedTree(["note", "read_only_loop"], {
      "src/lib/service/operations/note.ts": `
          await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
        `,
      "src/lib/service/operations/orientation.ts": `
          const rows = await ctx.db.$queryRawUnsafe(
            \`SELECT "id", "payload" FROM "Event"
              WHERE "itemId" = $1 AND "type" IN ('read_only_loop'::"EventType")\`,
            itemId,
          );
          function isLoop(event) { return event.type === "read_only_loop"; }
        `,
    });

    // Present as a string twice over — a SQL cast and a comparison — and
    // still correctly reported as having no emitter.
    expect(analyse(dir).unemitted).toEqual(["read_only_loop"]);
  });

  it("tells a read from a write in the real repository, not just in a fixture", () => {
    // The live instance of the defect above, asserted against this tree.
    //
    // The subject here has to be a type that is *read* somewhere and written
    // nowhere, and it must be chosen so that ordinary progress does not
    // falsify it: `open_loop` and `open_loop_closed` were the original
    // subjects and stopped being valid the moment their writers landed,
    // which broke this test on a tree where nothing was wrong. Anything
    // still on `KNOWN_UNEMITTED` is by definition a type whose writer has
    // not been built, so the waiver list is the honest source for it — and
    // when the last waiver goes, this test should be deleted rather than
    // repointed, because the property will have nothing left to observe.
    const result = analyse(repoRoot);
    const stillUnwritten = KNOWN_UNEMITTED.map((waiver) => waiver.type);
    expect(stillUnwritten.length).toBeGreaterThan(0);
    for (const type of stillUnwritten) {
      expect(result.emitters.has(type)).toBe(false);
    }
    // And `checkpoint`, which appears in the very same file in the very same
    // shape, IS emitted — so the distinction is doing real work here, not
    // just in a fixture.
    expect(result.emitters.has("checkpoint")).toBe(true);
  });

  it("fails a waiver that has outlived its reason", () => {
    // A waiver list nothing ever removes from is a place values go to stop
    // being checked. `note` is waived in the seeded tree *and* emitted in it.
    const dir = seedTree(["note"], {
      "src/lib/service/operations/note.ts": `
          await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
        `,
    });

    // `analyse` reads the real KNOWN_UNEMITTED, so this is asserted through
    // the live list: every waived type must genuinely have no emitter here.
    const result = analyse(repoRoot);
    expect(result.staleWaivers).toEqual([]);

    // And the mechanism itself, proven on a tree where it does fire: a type
    // that is both waived and emitted is reported.
    const seeded = analyse(dir);
    expect(seeded.declared).toEqual(["note"]);
    expect(seeded.emitters.has("note")).toBe(true);
  });

  it("reports a waiver whose type has since gained an emitter", () => {
    // **The assertion the test above was missing (#124).** It asserted
    // `staleWaivers` is `[]` on a clean repo and never exercised a tree where
    // the mechanism fires — so deleting the mechanism outright left all 28
    // tests passing, and a stale waiver went undetected with exit 0. A test
    // titled for a behaviour it never drives cannot fail on that behaviour.
    //
    // `analyse` reads the live KNOWN_UNEMITTED, so the seeded tree declares a
    // genuinely-waived type and then emits it. That is exactly the state a
    // waiver is supposed to catch: the promise it recorded has been kept, and
    // the entry should now be removed.
    const waived = KNOWN_UNEMITTED[0]?.type;
    expect(waived).toBeDefined();

    const dir = seedTree([waived as string], {
      "src/lib/service/operations/writer.ts": `
          await appendEvent(ctx.db, { itemId, type: "${waived}", payload: {} });
        `,
    });

    const result = analyse(dir);
    expect(result.staleWaivers.map((w: { type: string }) => w.type)).toEqual([waived]);
    // The site is what makes the failure actionable — "remove this entry"
    // is only useful next to the line that made it stale.
    const sites = result.staleWaivers[0]?.sites ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0]?.file).toBe("src/lib/service/operations/writer.ts");
  });

  it("exits non-zero on a stale waiver, and names it", () => {
    // The mechanism above reaching the exit code. `analyse` finding a stale
    // waiver while the binary exited 0 would gate nothing — the same gap as
    // the seeded-violation CLI test below, which is why both exist.
    const waived = KNOWN_UNEMITTED[0]?.type as string;
    const dir = seedTree([waived], {
      "src/lib/service/operations/writer.ts": `
        await appendEvent(ctx.db, { itemId, type: "${waived}", payload: {} });
      `,
    });
    const result = runCliIn(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale-waiver");
    expect(result.stderr).toContain(waived);
  });

  it("reports a waiver for a type the enum does not declare", () => {
    // The `unknownWaivers` half, which survived the same way: gutting it left
    // 28/28 passing. A waiver naming a type that does not exist waives
    // nothing, and its most likely cause is a typo in the entry — which
    // silently leaves the real type unwaived and unchecked.
    const dir = seedTree(["note"], {
      "src/lib/service/operations/note.ts": `
          await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
        `,
    });

    const result = analyse(dir);
    // Every live waiver names a type this tiny schema does not declare, so
    // all of them are unknown here — the mechanism firing, on real entries.
    expect(result.unknownWaivers.length).toBe(KNOWN_UNEMITTED.length);
    expect(result.unknownWaivers).toContain(KNOWN_UNEMITTED[0]?.type);
  });

  it("exits non-zero and says which type has no writer", () => {
    // The CLI path, through a real process. Seeded by pointing the checker at
    // a tree whose schema declares a value nothing writes — the exit code is
    // what CI reads, and an analyser that found the fault while the binary
    // exited 0 would gate nothing.
    const dir = seedTree(["note", "phantom_event"], {
      "src/lib/service/operations/note.ts": `
        await appendEvent(ctx.db, { itemId, type: "note", payload: {} });
      `,
    });
    // The script resolves its root from its own location, so run a copy of it
    // from inside the seeded tree.
    const seededScript = path.join(dir, "scripts", "check-event-emitters.mjs");
    mkdirSync(path.dirname(seededScript), { recursive: true });
    writeFileSync(
      seededScript,
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(require("fs").readFileSync(${JSON.stringify(scriptPath)}, "utf8"))`,
        ],
        {
          encoding: "utf8",
        },
      ),
      "utf8",
    );

    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [seededScript], { cwd: dir, encoding: "utf8" });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? -1;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain("phantom_event");
    expect(stderr).toContain("[no-emitter]");
  });
});

describe("check-event-emitters — what counts as a write", () => {
  it("counts a `type:` property on an object literal", () => {
    expect(propertyTypes(`appendEvent(db, { itemId, type: "claim", payload: {} })`)).toEqual([
      "claim",
    ]);
  });

  it("counts a quoted literal cast inside an INSERT", () => {
    expect(
      sqlTypes(`
        await db.$executeRawUnsafe(
          \`INSERT INTO "Event" ("itemId", "type", "payload")
            VALUES ($1, 'state_change'::"EventType", $2::jsonb)\`,
        );
      `),
    ).toEqual(["state_change"]);
  });

  it("does NOT count the same cast inside a SELECT", () => {
    // The single assertion this whole check turns on.
    expect(
      sqlTypes(`
        await db.$queryRawUnsafe(
          \`SELECT "id" FROM "Event"
            WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType"\`,
        );
      `),
    ).toEqual([]);
  });

  it("does NOT count a bare string in a union type", () => {
    expect(propertyTypes(`export type EventType = | "merge" | "review" | "open_loop";`)).toEqual(
      [],
    );
  });

  it("does NOT count a string comparison that merely looks like a property", () => {
    expect(propertyTypes(`if (event.type === "open_loop_closed") continue;`)).toEqual([]);
    expect(propertyTypes(`if (event.type !== "open_loop") continue;`)).toEqual([]);
  });

  it("does NOT count a mention in a comment", () => {
    expect(propertyTypes(`// the type: "merge" event is written by the merge operation`)).toEqual(
      [],
    );
  });

  it("still counts an emit on a line that earlier contains a URL", () => {
    // #124's LOW: `isInComment` searched for `//` in the raw line, so the
    // `//` in a URL read as a comment opener and silently skipped the emit
    // after it. String literals are blanked first now. This errs toward false
    // *failure*, which is the safe direction — but it is confusing to debug.
    expect(
      propertyTypes(`const url = "http://x"; await appendEvent(db, { type: "merge" })`),
    ).toEqual(["merge"]);
  });

  it("does NOT count a bound-parameter cast, which names no value", () => {
    expect(sqlTypes(`VALUES ($1, $2::"ActorType", $6::"EventType", $7::jsonb)`)).toEqual([]);
  });

  // ── The three read shapes that used to pass as writes (#124) ──────────
  //
  // The header claimed "there is no shape that makes an unemitted type look
  // emitted". Each of these is one: a plain `type:` property in a position
  // that reads a type rather than writing one. The last was demonstrated on a
  // real helper appended to `src/lib/open-loops.ts` and took the gate to
  // "12 emitted, exit 0" on a type nothing writes.

  it("does NOT count a `where:` clause, which reads events rather than writing one", () => {
    expect(propertyTypes(`db.event.findMany({ where: { type: "open_loop" } })`)).toEqual([]);
  });

  it("does NOT count an interface field declaring the type", () => {
    expect(propertyTypes(`interface L { type: "open_loop"; loopId: string }`)).toEqual([]);
  });

  it("does NOT count a read model returning the type", () => {
    // The exact helper from the issue.
    expect(
      propertyTypes(`
        export function toLoopView(e: { loopId: string }) {
          return { type: "open_loop", loopId: e.loopId, open: true };
        }
      `),
    ).toEqual([]);
  });

  it("DOES count the same property inside an emit call, so the narrowing is not blanket", () => {
    // The negative control for the three above. A check that simply stopped
    // counting properties would satisfy all of them and gate nothing — this
    // is the assertion that fails if the narrowing goes too far.
    expect(propertyTypes(`await appendEvent(ctx.db, { itemId, type: "open_loop" })`)).toEqual([
      "open_loop",
    ]);
    expect(propertyTypes(`await recordFieldChanges(db, { type: "field_change" })`)).toEqual([
      "field_change",
    ]);
  });

  it("counts an emit whose property sits inside a nested object", () => {
    // `payload: { … }` puts real emit sites more than one brace deep, so the
    // walk has to cross nested literals rather than stopping at the first one.
    expect(
      propertyTypes(`
        await appendEvent(db, {
          itemId,
          actor: { actorType, actorId, sessionId: null },
          type: "claim",
          payload: { role: "owner" },
        });
      `),
    ).toEqual(["claim"]);
  });

  it("records where each write was found, so a failure is actionable", () => {
    // The fixture is an `appendEvent` call rather than a bare object literal,
    // because a bare literal is no longer a write (#124) — it is the read-model
    // shape that made an unemitted type look emitted.
    const found = properties(`\n\nappendEvent(db, { type: "claim" });\n`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.kind).toBe("property");
  });
});

describe("check-event-emitters — reading the enum", () => {
  it("reads the declared values from the schema text", () => {
    expect(parseEventTypes(`enum EventType {\n  note\n  claim\n  merge\n}\n`)).toEqual([
      "note",
      "claim",
      "merge",
    ]);
  });

  it("ignores comments, including a commented-out value", () => {
    expect(
      parseEventTypes(
        `enum EventType {\n  note\n  // merge is written by the merge operation\n  // phantom\n  claim\n}\n`,
      ),
    ).toEqual(["note", "claim"]);
  });

  it("throws rather than silently scanning nothing when the enum is missing", () => {
    // The worst outcome for a gate is passing because it found nothing to
    // check. An absent enum is a loud failure, not an empty list.
    expect(() => parseEventTypes(`enum ActorType {\n  person\n}\n`)).toThrow(/EventType/);
  });

  it("agrees with the enum this repository actually declares", () => {
    const result = analyse(repoRoot);
    // Not a hardcoded count: the point is that the schema parses to a
    // non-trivial list, so a parser that silently returned [] would fail here.
    expect(result.declared.length).toBeGreaterThan(10);
    expect(result.declared).toContain("state_change");
    expect(result.declared).toContain("note");
  });
});

describe("check-event-emitters — the exclusions stay as narrow as intended", () => {
  // Both lists below are the check's blind spots by construction. Asserting
  // them exactly means widening one costs a visible diff in this file, with a
  // reviewer looking at it — rather than a quiet line added to a script.

  it("excludes exactly the import and generic-writer paths, and nothing else", () => {
    expect([...NON_EMITTER_PATHS].sort()).toEqual([
      "src/lib/events-backfill.ts",
      "src/lib/events-insert.ts",
      "src/lib/events.ts",
      "src/lib/import-events.ts",
    ]);
  });

  it("scans exactly the roots it claims to", () => {
    expect(EMITTER_ROOTS).toEqual(["src"]);
  });

  it("keeps every waiver's reason a real phrase naming a milestone row", () => {
    // A waiver whose reason is padding is a dismissal wearing a promise's
    // clothes. Each has to name the row that will close it.
    expect(KNOWN_UNEMITTED.length).toBeGreaterThan(0);
    for (const entry of KNOWN_UNEMITTED as Array<{ type: string; why: string }>) {
      expect(entry.why.split(/\s+/).length).toBeGreaterThanOrEqual(4);
      expect(entry.why).toMatch(/MILESTONES\.md #\d+/);
    }
  });

  it("does not read the excluded paths even though they contain event writes", () => {
    // Proves the exclusion is real rather than declarative: none of the
    // excluded files appears in the scanned set.
    const scanned = emitterFiles(repoRoot) as string[];
    for (const excluded of NON_EMITTER_PATHS as string[]) {
      expect(scanned).not.toContain(excluded);
    }
    // And the scan is not simply empty.
    expect(scanned.length).toBeGreaterThan(20);
  });
});

describe("check-event-emitters — what a green run does and does not mean", () => {
  // Stated as executable assertions rather than only in prose, so the limits
  // are checked rather than merely claimed. Read this block before trusting a
  // tick from this gate.

  it("green means every declared type has a WRITE SITE — not a reachable one", () => {
    // A writer nothing calls, behind a condition never true, satisfies this
    // check completely. That is by design: the thing that was missing was a
    // writer being *written*. Reachability is a different question and this
    // check does not ask it.
    const dir = seedTree(["ghost"], {
      "src/lib/service/operations/never-called.ts": `
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async function unreachable() {
          if (false) {
            await appendEvent(db, { type: "ghost", payload: {} });
          }
        }
      `,
    });

    expect(analyse(dir).unemitted).toEqual([]);
  });

  it("green says nothing about the payload being one any reader understands", () => {
    const dir = seedTree(["merge"], {
      "src/lib/service/operations/wrong.ts": `
        await appendEvent(db, { type: "merge", payload: { totally: "unrelated" } });
      `,
    });

    expect(analyse(dir).unemitted).toEqual([]);
  });

  it("a type built at run time is invisible to it — and fails, rather than passing quietly", () => {
    // The one direction the syntactic approach can be wrong in. It reports a
    // false FAILURE, never a false pass, which is the correct direction for a
    // gate whose purpose is catching an absence. The cost is that the
    // recognised shapes are a contract: write the type as a literal.
    const dir = seedTree(["computed"], {
      "src/lib/service/operations/dynamic.ts": `
        const chosen = someCondition ? "computed" : "note";
        await appendEvent(db, { type: chosen, payload: {} });
      `,
    });

    expect(analyse(dir).unemitted).toEqual(["computed"]);
  });

  it("code outside the scanned roots does not count, so a new root must be added", () => {
    const dir = seedTree(["elsewhere"], {
      "server/emits.ts": `await appendEvent(db, { type: "elsewhere", payload: {} });`,
    });

    expect(analyse(dir).unemitted).toEqual(["elsewhere"]);
  });

  it("passes over this repository as it stands", () => {
    // The whole point of landing the check and its waiver list together: the
    // check is not merely runnable, it is green on the tree it ships with.
    const result = runCli(repoRoot);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checked");
    // Reports the shape of what it found, so coverage cannot drop silently.
    expect(result.stdout).toMatch(/\d+ emitted/);
  });

  it("reports the waiver count in the summary, so the list growing is visible", () => {
    const result = runCli(repoRoot);
    expect(result.stdout).toMatch(/\d+ waivers? active/);
  });
});
