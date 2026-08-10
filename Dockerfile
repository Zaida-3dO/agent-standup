# Built in CI and pushed to GHCR. The deploy target never builds this image —
# it only pulls. See docker-compose.prod.yml.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# A second, production-only install. `prisma` (the CLI, needed at boot for
# `migrate deploy`) lives in "dependencies" for exactly this reason — it
# must survive `--omit=dev`. Kept as its own stage so it isn't invalidated
# by source changes, only by package.json/package-lock.json/schema changes.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
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

USER nextjs
EXPOSE 3000

# No migration exists yet (the initial baseline lands in a later PR) — this
# is forward-wired so the entrypoint doesn't need to change when it does.
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
