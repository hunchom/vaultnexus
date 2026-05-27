# VaultNexus daemon — single-stage Node 22 image.
# Bind-mount the vault at /vault. Use loopback within the container; expose :38473 if you
# tunnel from the host.
#
# Build:  docker build -t vaultnexus .
# Run:    docker run --rm -it \
#           -v "$HOME/Documents/MyVault:/vault:ro" \
#           -e VAULTNEXUS_VAULT=/vault \
#           -e VAULTNEXUS_EMBED_URL=https://api.voyageai.com/v1 \
#           -e VAULTNEXUS_EMBED_KEY=$VOYAGE_API_KEY \
#           -e VAULTNEXUS_EMBED_MODEL=voyage-3-large \
#           -p 127.0.0.1:38473:38473 \
#           vaultnexus

FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

# Pre-fetch deps separately → cache layer when only src changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY obsidian-plugin/package.json obsidian-plugin/package.json
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild better-sqlite3

COPY --from=build /app/dist ./dist

# Loopback-binding daemon. Override VAULTNEXUS_HTTP_PORT in env.
EXPOSE 38473
VOLUME /vault
VOLUME /var/lib/vaultnexus

ENV VAULTNEXUS_INDEX_SNAPSHOT=/var/lib/vaultnexus/index-snapshot.db
ENV NODE_ENV=production
CMD ["node", "dist/daemon/main.js"]
