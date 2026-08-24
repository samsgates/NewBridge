# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY tsconfig.base.json vitest.config.ts eslint.config.mjs ./
COPY scripts ./scripts
RUN npm ci || npm install
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S newbridge && adduser -S newbridge -G newbridge
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
USER newbridge
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "packages/gateway/dist/index.js"]
