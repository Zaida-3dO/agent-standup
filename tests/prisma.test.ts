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
});
