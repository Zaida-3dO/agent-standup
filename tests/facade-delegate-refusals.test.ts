// A facade operation's delegate schema must refuse by name, not throw.
//
// ── What is under test, and why the assertions are shaped this way ──────
//
// `create_work` stands in front of the three creates and applies the
// delegate's schema itself, below the runtime's parse. Two cross-field
// rules live only on the delegate schemas — exactly one of `area`/`areas`,
// and `originPersonId` when `originType` is `person` — so they are first
// applied at that inner parse. Applied with a bare `.parse()` they threw a
// `ZodError`, which is not a `ServiceError`, so the caller received
// `{"code":"internal","fields":[]}` for a mistake they could have fixed.
//
// **Every case here asserts the code, the named field AND the message.**
// Asserting only that a rejection happened is the hollow shape this repo
// keeps finding: `internal` is also a rejection, so such a test passes on
// the exact bug it was written to catch. `code === "invalid_input"` is the
// assertion that fails before the fix, and `fields` is what proves the
// caller was told *which* field — the difference between an actionable
// refusal and a shrug.
//
// The `internal`-in-reverse case is guarded too. Catching too broadly at
// the facade would turn a genuine server fault into a misleading
// `invalid_input`, which is this defect inverted and worse: it tells a
// caller to fix an input that was never the problem. The last describe
// block pins that direction.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { InternalError } from "@/lib/service/errors";
import { parseDelegateInput } from "@/lib/service/shape-refusal";
import { z } from "zod";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface Rejection {
  code: string;
  fields?: string[];
  message: string;
}

interface Created {
  id: string;
  kind: string;
  area: string;
}

describeIfDb("a facade's delegate schema refuses by name", () => {
  const dbName = scratchDatabaseName("facade_delegate_refusals");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const { url } = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = createTestPrismaClient(url);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  async function call(name: string, input: unknown): Promise<Created> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Created;
  }

  /** A create with neither cross-field rule satisfied yet, so a case adds only what it tests. */
  function work(title: string) {
    return { type: "task" as const, projectId: "inbox", title, body: "The brief." };
  }

  describe("exactly one of area or areas", () => {
    // THE REGRESSION CASE. This is the call from the original report,
    // verbatim in shape: a task with a project, a title, a body and a repo,
    // and neither `area` nor `areas`.
    //
    // Fails if `create-work.ts` goes back to `createTask.input.parse(...)`:
    // the ZodError becomes an `InternalError` and `code` is `internal`.
    it("names `areas` with invalid_input when neither spelling is supplied", async () => {
      const rejection = await rejectionOf("create_work", {
        ...work("Let people reset a password"),
        repo: "a-repo-name",
      });

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("areas");
      expect(rejection.message).toContain("exactly one of area or areas is required");
    });

    // The other half of the same rule, and the mistake a caller who read
    // "one of these two" makes next. Fails if `areaSpellingCheck` is
    // weakened from an exclusive-or to an or.
    it("names `areas` when BOTH spellings are supplied", async () => {
      const rejection = await rejectionOf("create_work", {
        ...work("Both spellings at once"),
        area: "api",
        areas: ["api"],
        originType: "auto",
      });

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("areas");
      expect(rejection.message).toContain("exactly one of area or areas is required");
    });
  });

  describe("originPersonId when originType is person", () => {
    // The second conditionally required field, reached only at the
    // delegate parse for the same reason. Fails if the `originPersonCheck`
    // refinement stops being applied through the facade.
    it("names `originPersonId` with invalid_input", async () => {
      const rejection = await rejectionOf("create_work", {
        ...work("A person raised this"),
        area: "api",
        originType: "person",
      });

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("originPersonId");
      expect(rejection.message).toContain("originPersonId is required when originType is person");
    });
  });

  describe("the refusal points at a contract that states the rule", () => {
    // The pointer must name the DELEGATE, because that is where the
    // conditional rule is written down. Pointing at `create_work` would
    // send a caller to a contract that does not state it.
    //
    // Fails if `parseDelegateInput` is passed the facade's own name.
    it("names create_task, not create_work", async () => {
      const rejection = await rejectionOf("create_work", work("Which contract"));

      expect(rejection.message).toContain("create_task");
      expect(rejection.message).toContain("describe_tool");
    });
  });

  describe("the fix did not break the path that worked", () => {
    // The call from the report that SUCCEEDED once both fields were
    // present. Fails if `parseDelegateInput` rejects a valid input — the
    // change must be invisible to a caller who got it right.
    //
    // No `repo` here, deliberately. The report's call carried one, but a
    // scratch database has no repos registered, so including it would fail
    // this case on `not_found` for a reason unrelated to what it tests. The
    // repo is covered where it belongs instead — by the case below, which
    // pins that an unknown repo is still reported as its own honest
    // `not_found` rather than being swept into the shape refusal.
    it("still creates a task when both conditional rules are satisfied", async () => {
      const created = await call("create_work", {
        ...work("Let people reset a forgotten password"),
        area: "api",
        originType: "auto",
      });

      expect(created.kind).toBe("task");
      expect(created.area).toBe("api");
    });

    // The correction the board row asked for, pinned as a test.
    //
    // The original feedback note concluded the `internal` was caused by an
    // unknown repo. It was not — but an unknown repo IS a real refusal, and
    // it must keep arriving as `not_found` naming `repo`, not folded into
    // the `invalid_input` this change introduces. A caller who sent a repo
    // that does not exist has a different thing to fix from one who omitted
    // an area, and the two codes are what tell them apart.
    //
    // Fails if the repo check is moved above the shape parse, or if
    // `parseDelegateInput` starts catching the delegate handler's throws.
    it("still reports an unknown repo as not_found naming repo", async () => {
      const rejection = await rejectionOf("create_work", {
        ...work("A repo that was never registered"),
        area: "api",
        originType: "auto",
        repo: "a-repo-that-does-not-exist",
      });

      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("repo");
      expect(rejection.message).toContain("a-repo-that-does-not-exist");
    });
  });

  describe("a genuine server fault is NOT relabelled as the caller's mistake", () => {
    // This defect in reverse, and the mutation most likely to be made
    // while fixing it: catching every throw at the facade and calling it
    // `invalid_input`. That would tell a caller to fix an input that was
    // never wrong, and would hide a real fault from the operator whose job
    // it is to see one.
    //
    // Driven directly rather than through the runtime because the point is
    // what `parseDelegateInput` does with a NON-schema failure: only
    // `safeParse`'s issues may become `invalid_input`. Fails if the helper
    // is rewritten as a try/catch around `.parse()` that classifies
    // anything it caught.
    it("lets a non-schema throw out unchanged", () => {
      const exploding = z.string().superRefine(() => {
        throw new InternalError("The database went away mid-validation.");
      });

      expect(() => parseDelegateInput("create_task", exploding, "anything", "mcp")).toThrow(
        InternalError,
      );
    });

    // The complement: the helper must not swallow a fault into a *value*
    // either. A helper that returned the raw input when validation could
    // not be completed would pass unvalidated data to the delegate.
    it("does not return a value when validation could not complete", () => {
      const exploding = z.string().superRefine(() => {
        throw new InternalError("The database went away mid-validation.");
      });

      let returned: unknown = "SENTINEL — the helper returned instead of throwing";
      try {
        returned = parseDelegateInput("create_task", exploding, "anything", "mcp");
      } catch {
        returned = undefined;
      }
      expect(returned).toBeUndefined();
    });
  });
});
