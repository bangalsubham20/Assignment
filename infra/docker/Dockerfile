# Stage 1: Build & compile TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first for Docker caching
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source code and documentation
COPY src/ ./src/
COPY docs/ ./docs/

# Compile TypeScript to dist/
RUN npm run build

# Stage 2: Production runtime
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Install tini for proper signal handling and zombie reaping
RUN apk add --no-cache tini curl

COPY package*.json ./
# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs ./docs

# Run as unprivileged node user (Defense in Depth)
USER node

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
