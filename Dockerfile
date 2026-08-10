FROM node:22-alpine AS builder

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for most platforms, but alpine/musl isn't always
# covered — these let npm fall back to compiling from source instead of failing the build.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV SQLITE_PATH=/app/data/dadstats.db

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Run as the image's built-in unprivileged user rather than root. /app/data is created and
# chowned here so a fresh named volume inherits that ownership — Docker copies the image
# directory's owner when it initialises an empty volume. A *bind* mount does NOT get this
# treatment: it keeps the host directory's ownership, so `-v /some/host/dir:/app/data` needs
# that host dir to be writable by uid 1000 (`chown 1000:1000 /some/host/dir`).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3108
VOLUME /app/data

# Node 22 has global fetch, so this needs no extra packages in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3108)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
