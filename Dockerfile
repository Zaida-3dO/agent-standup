# Built in CI and pushed to GHCR. The deploy target never builds this image —
# it only pulls. See docker-compose.prod.yml.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# `npm ci` runs the `prepare` lifecycle script (scripts/install-git-hooks.mjs),
# so that file has to be present in the build context before `npm ci` runs, not
# just later when the runner stage copies `scripts/` for the entrypoint. The
# script itself already no-ops cleanly when there's no `.git` here — it was
# only ever missing, not broken.
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

# A second, production-only install. `prisma` (the CLI, needed at boot for
# `migrate deploy`) lives in "dependencies" for exactly this reason — it
# must survive `--omit=dev`. Kept as its own stage so it isn't invalidated
# by source changes, only by package.json/package-lock.json/prisma/scripts
# changes.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` statically collects route metadata, which eagerly imports the
# Prisma client singleton (src/lib/prisma.ts) — it only needs DATABASE_URL to
# resolve as a well-formed connection string, never an actual connection (the
# app never queries at build time; same reasoning CI's own build-and-test job
# documents for the identical env var). This placeholder never reaches a
# running container — the runner stage below gets its real DATABASE_URL from
# the deploy environment, not from this stage.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Production node_modules first (brings the `prisma` CLI and its full
# dependency tree), then the standalone output on top — Next's file tracing
# overwrites the runtime pieces it actually needs (next, react, ...) with
# its leaner, traced copies, but tracing is known to sometimes miss Prisma's
# native query-engine binary, so that's re-copied explicitly below too.
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts

USER nextjs
EXPOSE 3000

# scripts/entrypoint.mjs: waits for Postgres to actually accept a query,
# applies the committed migrations, and only then starts `node server.js` —
# refusing to serve (nonzero exit, no server started) if either step fails.
# See scripts/entrypoint.mjs and scripts/lib/ for the reasoning.
CMD ["node", "scripts/entrypoint.mjs"]
