# Node 22 is supported LTS; pin the multi-platform image index, verified 2026-11-07.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_CODE_VERSION=2.1.319
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini git openssh-client bash ripgrep tmux procps && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)" \
    && npm cache clean --force
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/package.json ./
COPY scripts/container-ready.mjs ./scripts/container-ready.mjs
COPY docker-entrypoint.sh /usr/local/bin/claude-b-entrypoint
RUN chmod +x /usr/local/bin/claude-b-entrypoint /app/bin/cb \
    && ln -s /app/bin/cb /usr/local/bin/cb \
    && mkdir -p /workspace /home/node/.claude-b \
    && chown -R node:node /workspace /home/node/.claude-b
ENV CB_REST_HOST=0.0.0.0 \
    CB_REST_PORT=3847 \
    CB_DATA_DIR=/home/node/.claude-b \
    CLAUDE_CONFIG_DIR=/home/node/.claude-b/claude \
    DISABLE_AUTOUPDATER=1
USER node
# Executor ownership capture/recovery requires these exact fields at runtime.
RUN ps -p $$ -o pid= -o uid= -o pgid= -o stat= -o lstart= >/dev/null
WORKDIR /workspace
VOLUME ["/home/node/.claude-b"]
EXPOSE 3847
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "/app/scripts/container-ready.mjs", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/claude-b-entrypoint"]
CMD []
