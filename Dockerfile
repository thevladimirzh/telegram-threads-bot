# syntax=docker/dockerfile:1
# telegram-threads-bot runtime image (plan §2.9 item 9, D14/D15).
#
# Multi-stage: deps -> build (typecheck gate) -> runtime.
# The app has no build step (TS runs through tsx, tsconfig noEmit), so the
# "build" stage is a compile gate only. The final image contains no
# devDependencies: `tsx` (app runs via `npm start` -> `tsx src/index.ts`) and
# `drizzle-kit` (the Helm migrate Job runs `npm run db:migrate`) are therefore
# declared as production dependencies in package.json — they are runtime tools.
#
# Entry: `npm start` -> `tsx src/index.ts` (documented trade-off: npm forwards
# signals to the tsx/node child; acceptable for v1).
# Health server listens on PORT (default 8080) — see src/health.ts.

ARG NODE_VERSION=26

# --- deps: full dependency install (dev tooling needed for the typecheck gate) ---
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile-check sources (no emit) ---
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run typecheck

# --- runtime: production deps + sources + migrations, non-root ---
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/src ./src
COPY drizzle.config.ts ./
COPY migrations ./migrations
USER node
EXPOSE 8080
# Liveness of the health HTTP server (D20): /health on PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["npm", "start"]
