# syntax=docker/dockerfile:1.7
# =============================================================================
# Insight Replay — Dockerfile (multi-stage)
# =============================================================================
# Produces a slim production image running the Next.js standalone server
# under the Bun runtime.
#
# Stages:
#   1. deps    — install node_modules into a reusable layer (oven/bun:1.1)
#   2. builder — copy src + run `bun run build` → .next/standalone output
#   3. runner  — oven/bun:1.1-slim runtime, copies standalone + static + public
#
# Build context is the repo root (COPY . . in the builder stage). The sibling
# `.dockerignore` filters out node_modules / .next / .git / logs / tests /
# docs so they neither shadow the deps stage's installed node_modules nor
# pollute the build cache layers.
# -----------------------------------------------------------------------------

# ---------- Stage 1: deps ----------------------------------------------------
# Full bun image (not -slim) so that any native-build deps (e.g. sharp,
# @prisma/client engine binaries) have gcc / python / make available during
# `bun install`. The result is a fully populated /app/node_modules layer that
# the builder stage reuses.
FROM oven/bun:1.4 AS deps
WORKDIR /app

# Copy ONLY the package manifest up-front so that source-tree edits do NOT
# invalidate the (expensive) dependency-install layer. No lockfile is present
# in this repo, so we run `bun install` (which also writes one into the
# layer, but we discard it — the builder stage re-installs from package.json
# via the copied node_modules).
COPY package.json ./
RUN bun install

# ---------- Stage 2: builder -------------------------------------------------
# Same base as deps so the copied /app/node_modules binaries match the
# platform/arch of this stage (no cross-stage ABI mismatch).
FROM oven/bun:1.4 AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Re-use the dependency layer from stage 1.
COPY --from=deps /app/node_modules ./node_modules

# Copy the entire source tree (filtered by .dockerignore in the build context).
COPY . .

# Build. Per package.json, `next build` runs first, then the post-build step
# copies .next/static → .next/standalone/.next/ and public → .next/standalone/,
# so the standalone directory is self-contained by the time this stage ends.
RUN bun run build

# ---------- Stage 3: runner -------------------------------------------------
# Slim runtime — no build toolchain, smaller attack surface, smaller image.
# Bun is still required because the CMD invokes `bun` to start server.js.
FROM oven/bun:1.4-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Copy the standalone output (server.js + trimmed node_modules + package.json
# + the static/public dirs that the build script already inlined into it).
COPY --from=builder /app/.next/standalone ./.next/standalone

# Defense-in-depth: also copy .next/static and public explicitly INTO the
# standalone dir so the runtime layout is correct even if package.json's
# build script is later modified to skip the post-build cp steps. The Next.js
# standalone server resolves these paths relative to its own __dirname, i.e.
# /app/.next/standalone/.next/static and /app/.next/standalone/public.
COPY --from=builder /app/.next/static ./.next/standalone/.next/static
COPY --from=builder /app/public ./.next/standalone/public

# Next.js standalone server listens on $PORT (default 3000) at $HOSTNAME.
EXPOSE 3000

# Bun executes the standalone server.js. Path is relative to WORKDIR /app.
CMD ["bun", ".next/standalone/server.js"]
