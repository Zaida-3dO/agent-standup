// The admin entities' HTTP routes — `/repos`, `/areas`, `/machines`,
// `/accounts` — driven directly as route handlers (SCHEMA.md §22 "Cost… run
// in-process wherever the process boundary is not the thing being tested —
// call the route handler directly"), against a real Postgres. Same shape as
// tests/items-routes.test.ts and tests/settings-routes.test.ts.
//
// **Why this file exists, stated plainly.** tests/admin-operations.test.ts
// covers the service operations directly; this file covers the layer that
// exposes them — the route handlers, `admin-respond.ts`'s error-to-status
// mapping, and JSON parsing of the request body — none of which the
// operations tests exercise at all. It was also written to cover ground the
// mutation harness could not see at the time: Stryker used to drop any file
// whose path contains `[` (Next.js's bracket-path route directories,
// `repos/[id]`, `areas/[id]`, `machines/[name]`, `accounts/[id]`), silently
// excluding all four from instrumentation. That bug is now fixed (#64,
// `scripts/lib/mutation-scope.mjs`) — those four files are mutation-tested
// like any other as of this commit — but the tests below stay written as
// thoroughly as when no mutation harness could see them at all, because a
// route layer is exactly the kind of thin, easy-to-under-test shell where a
// green mutation score is the least reassuring signal available.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("admin entity HTTP routes against Postgres", () => {
  const dbName = scratchDatabaseName("admin_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let reposCollection: typeof import("@/app/api/repos/route");
  let repoItem: typeof import("@/app/api/repos/[id]/route");
  let areasCollection: typeof import("@/app/api/areas/route");
  let areaItem: typeof import("@/app/api/areas/[id]/route");
  let machinesCollection: typeof import("@/app/api/machines/route");
  let machineItem: typeof import("@/app/api/machines/[name]/route");
  let accountsCollection: typeof import("@/app/api/accounts/route");
  let accountItem: typeof import("@/app/api/accounts/[id]/route");
  let peopleCollection: typeof import("@/app/api/people/route");
  let personItem: typeof import("@/app/api/people/[id]/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint items-routes.test.ts documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches `service/live.ts`'s process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    reposCollection = await import("@/app/api/repos/route");
    repoItem = await import("@/app/api/repos/[id]/route");
    areasCollection = await import("@/app/api/areas/route");
    areaItem = await import("@/app/api/areas/[id]/route");
    machinesCollection = await import("@/app/api/machines/route");
    machineItem = await import("@/app/api/machines/[name]/route");
    accountsCollection = await import("@/app/api/accounts/route");
    accountItem = await import("@/app/api/accounts/[id]/route");
    peopleCollection = await import("@/app/api/people/route");
    personItem = await import("@/app/api/people/[id]/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  // ── repos ───────────────────────────────────────────────────────────
  describe("repos", () => {
    it("POST creates a repository and returns 201 with the created record", async () => {
      const response = await reposCollection.POST(
        jsonRequest("http://localhost/api/repos", "POST", {
          id: "route-repo-alpha",
          displayName: "Route Repo Alpha",
          defaultBranch: "main",
        }),
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { repo: { id: string; displayName: string } };
      expect(payload.repo).toMatchObject({
        id: "route-repo-alpha",
        displayName: "Route Repo Alpha",
      });
    });

    it("POST with malformed JSON returns 400 with the invalid_input envelope, not a 500", async () => {
      const response = await reposCollection.POST(
        new Request("http://localhost/api/repos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toEqual([]);
    });

    it("POST a duplicate id returns 409 conflict, naming the id field", async () => {
      await reposCollection.POST(
        jsonRequest("http://localhost/api/repos", "POST", {
          id: "route-repo-dup",
          displayName: "First",
          defaultBranch: "main",
        }),
      );
      const response = await reposCollection.POST(
        jsonRequest("http://localhost/api/repos", "POST", {
          id: "route-repo-dup",
          displayName: "Second",
          defaultBranch: "main",
        }),
      );
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("conflict");
      expect(payload.error.fields).toEqual(["id"]);
    });

    it("GET /repos/{id} reads back what POST created", async () => {
      await reposCollection.POST(
        jsonRequest("http://localhost/api/repos", "POST", {
          id: "route-repo-get",
          displayName: "Get Me",
          defaultBranch: "main",
        }),
      );
      const response = await repoItem.GET(
        new Request("http://localhost/api/repos/route-repo-get"),
        {
          params: Promise.resolve({ id: "route-repo-get" }),
        },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { repo: { displayName: string } };
      expect(payload.repo.displayName).toBe("Get Me");
    });

    it("GET /repos/{id} returns 404 for an id that does not exist", async () => {
      const response = await repoItem.GET(new Request("http://localhost/api/repos/no-such-repo"), {
        params: Promise.resolve({ id: "no-such-repo" }),
      });
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("not_found");
    });

    it("PATCH archives, and GET reflects it; PATCH un-archives, and GET reflects that too", async () => {
      await reposCollection.POST(
        jsonRequest("http://localhost/api/repos", "POST", {
          id: "route-repo-archive",
          displayName: "Archive Me",
          defaultBranch: "main",
        }),
      );

      const archived = await repoItem.PATCH(
        jsonRequest("http://localhost/api/repos/route-repo-archive", "PATCH", { archived: true }),
        { params: Promise.resolve({ id: "route-repo-archive" }) },
      );
      expect(archived.status).toBe(200);
      const archivedPayload = (await archived.json()) as { repo: { archivedAt: string | null } };
      expect(archivedPayload.repo.archivedAt).not.toBeNull();

      const list = await reposCollection.GET(new Request("http://localhost/api/repos"));
      const listPayload = (await list.json()) as { repos: { id: string }[] };
      expect(listPayload.repos.some((r) => r.id === "route-repo-archive")).toBe(false);

      const listAll = await reposCollection.GET(
        new Request("http://localhost/api/repos?includeArchived=true"),
      );
      const listAllPayload = (await listAll.json()) as { repos: { id: string }[] };
      expect(listAllPayload.repos.some((r) => r.id === "route-repo-archive")).toBe(true);
    });

    it("PATCH on a non-existent id returns 404, not a 500 or a silent success", async () => {
      const response = await repoItem.PATCH(
        jsonRequest("http://localhost/api/repos/does-not-exist", "PATCH", { displayName: "x" }),
        { params: Promise.resolve({ id: "does-not-exist" }) },
      );
      expect(response.status).toBe(404);
    });
  });

  // ── areas ───────────────────────────────────────────────────────────
  describe("areas", () => {
    it("POST finds-or-creates by normalised name and returns 201", async () => {
      const response = await areasCollection.POST(
        jsonRequest("http://localhost/api/areas", "POST", { name: "  Route Area  " }),
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { area: { id: string; displayName: string } };
      expect(payload.area).toMatchObject({ id: "route-area", displayName: "Route Area" });
    });

    it("GET /areas/{id} returns 404 for an id that does not exist", async () => {
      const response = await areaItem.GET(new Request("http://localhost/api/areas/no-such-area"), {
        params: Promise.resolve({ id: "no-such-area" }),
      });
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("not_found");
    });

    it("PATCH renames the display name without changing the id, and archives it", async () => {
      await areasCollection.POST(
        jsonRequest("http://localhost/api/areas", "POST", { name: "renameviaroute" }),
      );

      const renamed = await areaItem.PATCH(
        jsonRequest("http://localhost/api/areas/renameviaroute", "PATCH", {
          displayName: "Renamed",
        }),
        { params: Promise.resolve({ id: "renameviaroute" }) },
      );
      expect(renamed.status).toBe(200);
      const renamedPayload = (await renamed.json()) as {
        area: { id: string; displayName: string };
      };
      expect(renamedPayload.area).toMatchObject({ id: "renameviaroute", displayName: "Renamed" });

      const archived = await areaItem.PATCH(
        jsonRequest("http://localhost/api/areas/renameviaroute", "PATCH", { archived: true }),
        { params: Promise.resolve({ id: "renameviaroute" }) },
      );
      const archivedPayload = (await archived.json()) as { area: { archivedAt: string | null } };
      expect(archivedPayload.area.archivedAt).not.toBeNull();
    });
  });

  // ── machines — PATCH upserts (a bracket-path route; see this file's header) ──
  describe("machines", () => {
    it("GET /machines/{name} returns 404 for a name that has never been touched", async () => {
      const response = await machineItem.GET(
        new Request("http://localhost/api/machines/never-touched"),
        { params: Promise.resolve({ name: "never-touched" }) },
      );
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("not_found");
    });

    it("PATCH on a name that has never been created upserts it — the deviation from §19's literal verb table", async () => {
      const response = await machineItem.PATCH(
        jsonRequest("http://localhost/api/machines/route-desktop", "PATCH", {
          sourceGlobs: ["apps/**", "services/**"],
        }),
        { params: Promise.resolve({ name: "route-desktop" }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        machine: {
          name: string;
          sourceGlobs: string[] | null;
          lastPollAt: string | null;
          liveSessions: number;
        };
      };
      expect(payload.machine).toEqual({
        name: "route-desktop",
        sourceGlobs: ["apps/**", "services/**"],
        lastPollAt: null,
        liveSessions: 0,
      });

      // And GET now finds it — proving the PATCH really created a durable row.
      const getResponse = await machineItem.GET(
        new Request("http://localhost/api/machines/route-desktop"),
        { params: Promise.resolve({ name: "route-desktop" }) },
      );
      expect(getResponse.status).toBe(200);
    });

    it("PATCH --clear (null) clears an existing override back to inherit", async () => {
      await machineItem.PATCH(
        jsonRequest("http://localhost/api/machines/route-clear-me", "PATCH", {
          sourceGlobs: ["a/**"],
        }),
        { params: Promise.resolve({ name: "route-clear-me" }) },
      );
      const cleared = await machineItem.PATCH(
        jsonRequest("http://localhost/api/machines/route-clear-me", "PATCH", { sourceGlobs: null }),
        { params: Promise.resolve({ name: "route-clear-me" }) },
      );
      expect(cleared.status).toBe(200);
      const payload = (await cleared.json()) as { machine: { sourceGlobs: string[] | null } };
      expect(payload.machine.sourceGlobs).toBeNull();
    });

    it("PATCH with an invalid sourceGlobs value returns 400, naming the field, not a 500", async () => {
      const response = await machineItem.PATCH(
        jsonRequest("http://localhost/api/machines/route-bad-globs", "PATCH", {
          sourceGlobs: [""],
        }),
        { params: Promise.resolve({ name: "route-bad-globs" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toEqual(["sourceGlobs"]);
    });

    it("PATCH with malformed JSON returns 400, not a 500", async () => {
      const response = await machineItem.PATCH(
        new Request("http://localhost/api/machines/route-malformed", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ name: "route-malformed" }) },
      );
      expect(response.status).toBe(400);
    });

    it("GET /machines lists every machine PATCH has created so far", async () => {
      const response = await machinesCollection.GET();
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { machines: { name: string }[] };
      expect(payload.machines.some((m) => m.name === "route-desktop")).toBe(true);
    });
  });

  // ── accounts — PATCH upserts (a bracket-path route; see this file's header) ──
  describe("accounts", () => {
    it("PATCH on a new id with vendor, displayName and planType creates it — the upsert path", async () => {
      const response = await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-new", "PATCH", {
          vendor: "anthropic",
          displayName: "Route Account",
          planType: "subscription",
        }),
        { params: Promise.resolve({ id: "route-account-new" }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        account: { id: string; vendor: string; planType: string };
      };
      expect(payload.account).toMatchObject({
        id: "route-account-new",
        vendor: "anthropic",
        planType: "subscription",
      });

      const getResponse = await accountItem.GET(
        new Request("http://localhost/api/accounts/route-account-new"),
        { params: Promise.resolve({ id: "route-account-new" }) },
      );
      expect(getResponse.status).toBe(200);
    });

    it("PATCH on a new id missing a required field returns 400, naming the missing fields", async () => {
      const response = await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-incomplete", "PATCH", {
          vendor: "anthropic",
        }),
        { params: Promise.resolve({ id: "route-account-incomplete" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields.sort()).toEqual(["displayName", "planType"]);
    });

    it("PATCH with an unregistered vendor returns 400 on create, naming vendor, not a 500", async () => {
      const response = await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-bad-vendor", "PATCH", {
          vendor: "not-a-real-vendor",
          displayName: "Bad Vendor",
          planType: "subscription",
        }),
        { params: Promise.resolve({ id: "route-account-bad-vendor" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toEqual(["vendor"]);
    });

    it("PATCH with an unregistered vendor on an EXISTING account is refused, and the stored vendor is untouched", async () => {
      await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-switch", "PATCH", {
          vendor: "anthropic",
          displayName: "Switch Me",
          planType: "subscription",
        }),
        { params: Promise.resolve({ id: "route-account-switch" }) },
      );

      const rejected = await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-switch", "PATCH", {
          vendor: "still-not-real",
        }),
        { params: Promise.resolve({ id: "route-account-switch" }) },
      );
      expect(rejected.status).toBe(400);

      const getResponse = await accountItem.GET(
        new Request("http://localhost/api/accounts/route-account-switch"),
        { params: Promise.resolve({ id: "route-account-switch" }) },
      );
      const payload = (await getResponse.json()) as { account: { vendor: string } };
      expect(payload.account.vendor).toBe("anthropic");
    });

    it("PATCH with an invalid budgetWindows shape returns 400, naming the field", async () => {
      const response = await accountItem.PATCH(
        jsonRequest("http://localhost/api/accounts/route-account-crossing", "PATCH", {
          vendor: "anthropic",
          displayName: "Crossing",
          planType: "subscription",
          budgetWindows: {
            primary: {
              enabled: true,
              lengthHours: 24,
              boundaries: {
                selective: { kind: "constant", value: 90 },
                windDown: { kind: "constant", value: 10 },
                stop: { kind: "constant", value: 95 },
              },
            },
          },
        }),
        { params: Promise.resolve({ id: "route-account-crossing" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toEqual(["budgetWindows"]);
    });

    it("GET /accounts/{id} returns 404 for an id that does not exist", async () => {
      const response = await accountItem.GET(
        new Request("http://localhost/api/accounts/no-such-account"),
        { params: Promise.resolve({ id: "no-such-account" }) },
      );
      expect(response.status).toBe(404);
    });

    it("GET /accounts lists every account PATCH has created so far", async () => {
      const response = await accountsCollection.GET();
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { accounts: { id: string }[] };
      expect(payload.accounts.some((a) => a.id === "route-account-new")).toBe(true);
    });
  });

  // ── people ──────────────────────────────────────────────────────────
  describe("people", () => {
    // Opens with the attack, deliberately. `PATCH /people/{id}` spreads the
    // body and then the path id (`{ ...body, id }`), so the URL wins; writing
    // it the other way round lets a body-supplied `id` decide which row is
    // written, and `PATCH /people/alice` with `{"id":"bob"}` writes **bob**.
    // That transposition survived the entire suite, and it is the same shape
    // as the session-registration route hijack (#119).
    it("a body id cannot override the path id — the path is the only source of truth", async () => {
      await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-target", "PATCH", {
          displayName: "Target",
        }),
        { params: Promise.resolve({ id: "route-person-target" }) },
      );

      const response = await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-target", "PATCH", {
          id: "route-person-hijacked",
          displayName: "Renamed via the path",
        }),
        { params: Promise.resolve({ id: "route-person-target" }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { person: { id: string; displayName: string } };

      // The row the URL named was written…
      expect(payload.person.id).toBe("route-person-target");
      expect(payload.person.displayName).toBe("Renamed via the path");
      // …and the row the *body* named was never created. Asserted against the
      // database rather than the response, because a handler that answered
      // with the path id while writing the body id would pass on the response
      // alone — which is precisely the bug.
      const hijacked = await prisma.person.findUnique({
        where: { id: "route-person-hijacked" },
      });
      expect(hijacked).toBeNull();
    });

    it("PATCH on a new id with a displayName creates it — the upsert path", async () => {
      const response = await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-new", "PATCH", {
          displayName: "Route Person",
        }),
        { params: Promise.resolve({ id: "route-person-new" }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        person: { id: string; displayName: string };
      };
      expect(payload.person).toMatchObject({
        id: "route-person-new",
        displayName: "Route Person",
      });
    });

    it("PATCH on a new id missing displayName returns 400, naming the missing field", async () => {
      const response = await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-incomplete", "PATCH", {
          colour: "#123456",
        }),
        { params: Promise.resolve({ id: "route-person-incomplete" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toContain("displayName");
    });

    it("PATCH with malformed JSON returns 400, not a 500", async () => {
      // The sibling entities all carry this case: a body that is not JSON is
      // the caller's mistake, and a 500 would report it as ours.
      const response = await personItem.PATCH(
        new Request("http://localhost/api/people/route-person-bad-json", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id: "route-person-bad-json" }) },
      );
      expect(response.status).toBe(400);
    });

    it("PATCH updates an existing person rather than creating a second row", async () => {
      await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-update", "PATCH", {
          displayName: "Before",
        }),
        { params: Promise.resolve({ id: "route-person-update" }) },
      );
      const response = await personItem.PATCH(
        jsonRequest("http://localhost/api/people/route-person-update", "PATCH", {
          displayName: "After",
        }),
        { params: Promise.resolve({ id: "route-person-update" }) },
      );
      expect(response.status).toBe(200);

      const rows = await prisma.person.findMany({ where: { id: "route-person-update" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe("After");
    });

    it("GET /people lists every person PATCH has created so far", async () => {
      const response = await peopleCollection.GET();
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { people: { id: string }[] };
      expect(payload.people.some((p) => p.id === "route-person-new")).toBe(true);
    });
  });
});
