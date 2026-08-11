import { PrismaClient } from "@prisma/client";
import { withPoolDefaults } from "./db-url";

// Standard Next.js + Prisma singleton: in dev, `next dev` hot-reloads modules
// on every save, which would otherwise construct a fresh PrismaClient (and a
// fresh connection pool) per reload. Caching the instance on `globalThis`
// survives the reload; in production each server process builds exactly one.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — see .env.example.");
  }
  // Pooling is applied here, not left to Prisma's own per-host default —
  // see db-url.ts for the reasoning behind the numbers.
  return new PrismaClient({ datasourceUrl: withPoolDefaults(databaseUrl) });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
