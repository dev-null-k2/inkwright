# syntax=docker/dockerfile:1.7
#
# Inkstone appliance images (docs/ENTERPRISE.md). One Dockerfile, two targets:
#
#   docker build -f deploy/Dockerfile --target server -t inkstone-server .   # MCP + A2A + routine runner
#   docker build -f deploy/Dockerfile --target web    -t inkstone-web .      # the web app behind nginx
#
# Pin base images by digest in production (see docs/ENTERPRISE.md › Supply chain); the tags below
# are the versions this file was written and tested against.

ARG NODE_IMAGE=node:22.11-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

# ---- Build: everything from source, with the lockfile ----------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    CI=1 \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/sync/package.json packages/sync/
COPY apps/web/package.json apps/web/
COPY apps/mcp-server/package.json apps/mcp-server/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY . .
# The appliance's web build asks for the administrator's managed AI policy next to index.html.
ENV VITE_MANAGED_POLICY_URL=managed-policy.json
RUN npm run build -w @inkstone/web && npm run build -w @inkstone/mcp-server && mkdir -p /out/vault

# ---- Server: the bundled MCP/A2A server and runner, no shell, non-root --------------------------
FROM ${RUNTIME_IMAGE} AS server
WORKDIR /app
COPY --from=build /src/apps/mcp-server/dist ./dist
# Optional native PNG renderer for page images (falls back to SVG without it).
COPY --from=build /src/node_modules/@resvg ./node_modules/@resvg
# The vault volume mount point, owned by the runtime user so a fresh named volume is writable.
COPY --from=build --chown=65532:65532 /out/vault /vault
ENV NODE_ENV=production \
    INKSTONE_VAULT=/vault \
    INKSTONE_HTTP_PORT=8765 \
    INKSTONE_HOST=0.0.0.0
USER nonroot
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8765/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# `run` serves MCP (and A2A with INKSTONE_A2A=1) on the HTTP port and runs routines.
ENTRYPOINT ["/nodejs/bin/node", "dist/agent.js"]
CMD ["run"]

# ---- Web: static files behind nginx, non-root, read-only friendly --------------------------------
FROM ${NGINX_IMAGE} AS web
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# Replaced by the administrator's policy through a bind mount (compose); this default changes nothing.
COPY --chmod=0644 deploy/managed-policy.default.json /usr/share/nginx/html/managed-policy.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
