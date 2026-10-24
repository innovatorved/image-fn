FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV ENVIRONMENT=production
ENV PORT=8787
ENV AZURE_REGION=eastus
ENV MAX_IMAGE_PIXELS=268435456
ENV MAX_OUTPUT_PIXELS=41943040
ENV MAX_SOURCE_BYTES=26214400
ENV MAX_CACHE_BYTES=134217728
ENV SOURCE_FETCH_TIMEOUT_MS=10000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD ["bun", "src/scripts/probe-health.ts"]
CMD ["bun", "src/index.ts"]
