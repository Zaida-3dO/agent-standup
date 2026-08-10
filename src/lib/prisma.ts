import { PrismaClient } from "@prisma/client";

// Standard Next.js + Prisma singleton: in dev, `next dev` hot-reloads modules
// on every save, which would otherwise construct a fresh PrismaClient (and a
// fresh connection pool) per reload. Caching the instance on `globalThis`
// survives the reload; in production each server process builds exactly one.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
