# ---------- Builder ----------
FROM node:20-alpine AS builder

# node-pty needs a toolchain to build on alpine
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build

# Drop dev deps
RUN npm prune --omit=dev

# ---------- Runtime ----------
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/package.json ./
COPY docker-entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /app/bin/cb && \
    ln -s /app/bin/cb /usr/local/bin/cb

# Persisted state — mount a volume here for data preservation.
VOLUME ["/root/.claude-b"]

EXPOSE 3847

ENV CB_REST_HOST=0.0.0.0 \
    CB_REST_PORT=3847 \
    CB_DATA_DIR=/root/.claude-b

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
