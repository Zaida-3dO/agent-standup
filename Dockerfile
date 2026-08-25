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
# `GET /api/hook/script` (src/app/api/hook/script/route.ts, MILESTONES.md
# #125(b)) reads this at runtime under `dist/hook-scripts/` — the
# self-contained, servable build `scripts/build-hook-scripts.mjs` produces,
# distinct from `dist/bin/` (the split, published-package build `npm run
# build:cli` also makes, and which this image never needs). `esbuild` is a
# devDependency, so this has to run in a stage that still has `deps`'
# `node_modules`, not the production-only `prod-deps` one below.
RUN node scripts/build-hook-scripts.mjs

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
COPY --from=build --chown=nextjs:nodejs /app/dist/hook-scripts ./dist/hook-scripts

# What code this image contains, so the running process can answer "what is
# deployed" without anyone shelling in to read an OCI label.
#
# These are the LAST thing in the build on purpose. Every ARG/ENV pair
# invalidates the layers below it, so declaring them up here — after every
# COPY and RUN — means a new sha changes exactly one trivial metadata layer
# and reuses the whole cached build. Declared in the runner stage only:
# earlier stages never reference them, so `npm ci` and `next build` stay
# cached across commits.
#
# `.github/workflows/release.yml` passes these from the same tag and sha
# that `docker/metadata-action` writes into the OCI labels, so the label and
# the running process can never disagree about what was built. A build that
# passes nothing gets empty strings, which `src/lib/build-info.ts` reads as
# absent and reports as `0.0.0-dev` / `unknown` — deliberately not a
# plausible version, so an unreleased build cannot be mistaken for a
# released one.
ARG APP_VERSION=""
ARG APP_REVISION=""
ARG APP_BUILD_TIME=""
ENV APP_VERSION=$APP_VERSION
ENV APP_REVISION=$APP_REVISION
ENV APP_BUILD_TIME=$APP_BUILD_TIME

USER nextjs
EXPOSE 3000

# scripts/entrypoint.mjs: waits for Postgres to actually accept a query,
# applies the committed migrations, and only then starts `node server.js` —
# refusing to serve (nonzero exit, no server started) if either step fails.
# See scripts/entrypoint.mjs and scripts/lib/ for the reasoning.
CMD ["node", "scripts/entrypoint.mjs"]
