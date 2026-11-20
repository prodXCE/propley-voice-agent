FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 && npm cache clean --force

# The LiveKit room connection runs in Rust (@livekit/rtc-node) and verifies TLS against the system store, which
# node:20-slim does not have. Without this every job failed with "failed to retrieve region info" (17-20 Nov 2026).
# After npm ci, so a rebuild keeps that heavy layer cached.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

USER node

EXPOSE 8081

CMD ["node", "dist/index.js", "start"]
