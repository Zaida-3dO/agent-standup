import { afterEach, describe, expect, it, vi } from "vitest";

describe("prisma singleton", () => {
  const globalForPrisma = globalThis as unknown as { prisma?: unknown };

  afterEach(() => {
    delete globalForPrisma.prisma;
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("caches the client on globalThis so a module re-evaluation reuses it", async () => {
    vi.stubEnv("NODE_ENV", "development");

    vi.resetModules();
    const first = await import("@/lib/prisma");
    expect(globalForPrisma.prisma).toBe(first.prisma);

    // `next dev` re-evaluates modules on every save. Simulate that by
    // clearing the module registry and importing again — a correct
    // implementation reuses the cached instance from globalThis instead
    // of constructing a fresh PrismaClient (and connection pool).
    vi.resetModules();
    const second = await import("@/lib/prisma");
    expect(second.prisma).toBe(first.prisma);
  });

  it("exports a real PrismaClient with the generated model delegates", async () => {
    const { prisma } = await import("@/lib/prisma");
    expect(prisma.item).toBeDefined();
    expect(typeof prisma.item.findMany).toBe("function");
  });

  it("throws a clear error instead of Prisma's generic one when DATABASE_URL is unset", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.resetModules();
    await expect(import("@/lib/prisma")).rejects.toThrow(/DATABASE_URL is not set/);
  });

  it("builds a pooled datasource URL rather than passing DATABASE_URL through unmodified", async () => {
    // A regression guard on the actual wiring, not just that the module
    // imports: mock @prisma/client's export and inspect what prisma.ts's
    // `new PrismaClient(...)` call site actually received. Asserting only
    // "resolves.not.toThrow()" would still pass even with withPoolDefaults
    // stripped from prisma.ts entirely — a raw DATABASE_URL is just as
    // valid a constructor argument as a pooled one, so only inspecting the
    // received value catches a call site that stops wiring the two
    // together.
    const rawDatabaseUrl = "postgresql://test:test@localhost:5432/test";
    vi.stubEnv("DATABASE_URL", rawDatabaseUrl);

    const PrismaClientMock = vi.fn();
    vi.doMock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));

    try {
      vi.resetModules();
      await import("@/lib/prisma");

      expect(PrismaClientMock).toHaveBeenCalledTimes(1);
      const options = PrismaClientMock.mock.calls[0]?.[0] as { datasourceUrl?: string };
      expect(options.datasourceUrl).toBeDefined();
      expect(options.datasourceUrl).not.toBe(rawDatabaseUrl);
      expect(options.datasourceUrl).toContain("connection_limit=");
      expect(options.datasourceUrl).toContain("pool_timeout=");
    } finally {
      vi.doUnmock("@prisma/client");
    }
  });
});
