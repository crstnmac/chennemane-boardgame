# syntax=docker/dockerfile:1.7
# Chennamane — static Vite SPA for Dokploy / any Docker host.
# Multi-stage: pnpm build → nginx (port 80).

# ── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

# pnpm via Corepack (matches local lockfile workflow)
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

# Install deps first (better layer cache)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source + public 3D/audio/texture assets (required at build time)
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY src ./src
COPY public ./public

# Typecheck + production bundle (PWA + hashed assets)
ENV NODE_ENV=production
RUN pnpm run build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Drop default site; use SPA-aware config
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/chennamane.conf

# Static site only — no Node in the final image
COPY --from=build /app/dist /usr/share/nginx/html

# Non-root-friendly: nginx master still runs as root briefly then workers drop;
# healthcheck + labels for Dokploy / Traefik discovery
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1

LABEL org.opencontainers.image.title="Chennamane" \
      org.opencontainers.image.description="Traditional South Indian mancala (Bule Perga) browser game" \
      org.opencontainers.image.source="https://github.com/cristonmascarenhas/chennamane"

CMD ["nginx", "-g", "daemon off;"]
