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
ENV PORT=3847

# Start daemon with REST API
CMD ["node", "dist/daemon/index.js"]
