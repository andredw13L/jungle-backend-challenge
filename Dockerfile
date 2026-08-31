# syntax=docker/dockerfile:1.7

# Slice 1 keeps the Dockerfile minimal so the bootable scaffold can be
# verified. Slice 10 finalises the multi-stage build for the production image.
# Runtime is Bun (per the README stack table); Node is only used for tsc.
FROM oven/bun:1.1 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun run scripts/build.ts

FROM oven/bun:1.1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
RUN bun install --production --frozen-lockfile
EXPOSE 3101
CMD ["bun", "dist/main.js"]