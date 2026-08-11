FROM node:26-alpine AS builder

WORKDIR /app

# better-sqlite3 is a native module. Prebuilt binaries don't cover every platform (notably
# alpine/musl on arm64), so the toolchain has to be here — and *only* here. Shipping it in the
# runtime image would multiply the image size for something used once, at build time.
RUN apk add --no-cache python3 make g++

# npm ci, not npm install: it installs exactly what the lockfile pins, so a rebuild in a year
# produces the same tree as today rather than silently picking up new minor versions.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine

WORKDIR /app

# su-exec drops privileges in the entrypoint. ~20KB, and the alternative (running as root) is
# worse.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production
ENV SQLITE_PATH=/app/data/dadstats.db

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN chmod +x /app/docker-entrypoint.sh

# Ownership of /app/data is fixed by the entrypoint at runtime, not here — a mount replaces
# whatever the image put at this path. See docker-entrypoint.sh.
RUN mkdir -p /app/data

EXPOSE 3108
VOLUME /app/data

# Hits an endpoint that actually queries the database. A process that's listening but can't read
# its own data is not healthy, and a plain port check would call it fine.
# Node 22 has global fetch, so this needs nothing extra installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3108)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="DadStats" \
      org.opencontainers.image.description="Self-hosted sports stat tracker for kids' games, with live multi-device scoring" \
      org.opencontainers.image.source="https://github.com/raymondoooo/dadstats" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
