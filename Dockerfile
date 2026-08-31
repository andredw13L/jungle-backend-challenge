# syntax=docker/dockerfile:1.7

# Multi-stage build (finalised in slice 10). Build stage compiles src/ to
# dist/ with tsc; runtime stage ships dist/ plus src/scripts/migrations because
# the operational one-shots (migrate, readiness) execute TypeScript sources
# directly under Bun.
FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN bun install --frozen-lockfile
RUN bun run scripts/build.ts

FROM oven/bun:1.4.0 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/dist ./dist
# Scripts import ../src/*, and Bun runs TS natively — no extra build step.
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
RUN bun install --production --frozen-lockfile
EXPOSE 3101
CMD ["bun", "dist/main.js"]
