# mstamp backend image.
#
# NOTE: this file has NOT been built or run. Docker was not installed in the
# environment where it was written, so the command sequence below is reasoned
# about, not executed. Verify before relying on it:
#
#   docker build -t mstamp-backend .
#   docker run --rm -e DATABASE_URL=... -e MSTAMP_SIGNING_KEY=... -e MSTAMP_MASTER_KEY=... \
#     -p 3000:3000 mstamp-backend
#
# `docs/deploy.md` documents the same steps without Docker, which is the path that
# was actually exercised.

# syntax=docker/dockerfile:1

# --- build -------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Manifests first, so this layer caches when only source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/backend/package.json packages/backend/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages

# Builds in dependency order: protocol before backend.
RUN pnpm run build

# --- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Only production dependencies are installed here. The workspace link to
# @mstamp/protocol is recreated from the manifests, and its build output was
# copied from the build stage, so nothing is compiled twice.
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/backend/package.json packages/backend/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
# Migrations are resolved at runtime as ../../migrations from dist/db/migrate.js,
# so this path is load-bearing and must not move.
COPY --from=build /app/packages/backend/migrations packages/backend/migrations

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# Run as a non-root user. Nothing in the service needs to write, except the
# package manager during the layer above.
RUN useradd --create-home --uid 10001 mstamp
USER mstamp

WORKDIR /app/packages/backend

EXPOSE 3000
CMD ["node", "dist/serve.js"]
