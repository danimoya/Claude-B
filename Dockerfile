FROM node:20-alpine

# Install build dependencies for node-pty
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build
RUN npm run build

# Create data directory
RUN mkdir -p /root/.claude-b

# Expose REST API port
EXPOSE 3847

# Set default environment
ENV ANTHROPIC_API_KEY=""
ENV REST_HOST="0.0.0.0"
ENV REST_PORT="3847"

# Copy and set entrypoint
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Start daemon with REST API
CMD ["/entrypoint.sh"]
