# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN apt-get update && \
    apt-get install --yes --no-install-recommends g++ make python3 && \
    npm install --global pnpm@11.9.0 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./

RUN --mount=type=cache,id=tokems-pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .

ARG NUXT_PUBLIC_API_BASE=/api/v1
ARG NUXT_PUBLIC_ORGANIZATION_SLUG=tokems-demo
ARG VITE_API_BASE=/api/v1
ARG VITE_ADMIN_BASE=/admin/
ARG VITE_SIMPLE_AUTH=false
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG BUILD_MIGRATION=unknown

ENV NUXT_PUBLIC_API_BASE=${NUXT_PUBLIC_API_BASE}
ENV NUXT_PUBLIC_ORGANIZATION_SLUG=${NUXT_PUBLIC_ORGANIZATION_SLUG}
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_ADMIN_BASE=${VITE_ADMIN_BASE}
ENV VITE_SIMPLE_AUTH=${VITE_SIMPLE_AUTH}
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV BUILD_MIGRATION=${BUILD_MIGRATION}

RUN --mount=type=cache,id=tokems-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile

RUN pnpm build

RUN node tooling/write-build-info.mjs --service admin --output /workspace/.build-info/admin/version.json && \
    node tooling/write-build-info.mjs --service gateway --output /workspace/.build-info/gateway/version.json

RUN --mount=type=cache,id=tokems-pnpm-store,target=/pnpm/store \
    pnpm --filter @conference/api deploy --prod --legacy /opt/deploy/api && \
    pnpm --filter @conference/worker deploy --prod --legacy /opt/deploy/worker

FROM ${NODE_IMAGE} AS api

ENV NODE_ENV=production
ENV API_PORT=4100

WORKDIR /app

COPY --chown=node:node --from=workspace /opt/deploy/api/ ./

USER node

EXPOSE 4100

CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS worker

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node --from=workspace /opt/deploy/worker/ ./

USER node

CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS web

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --chown=node:node --from=workspace /workspace/apps/web/.output/ ./

USER node

EXPOSE 3000

CMD ["node", "server/index.mjs"]

FROM nginx:1.31-alpine AS admin

COPY docker/admin.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=workspace /workspace/apps/admin/dist/ /usr/share/nginx/html/
COPY --from=workspace /workspace/.build-info/admin/version.json /usr/share/nginx/html/version.json

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]

FROM nginx:1.31-alpine AS gateway

COPY docker/gateway.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=workspace /workspace/.build-info/gateway/version.json /usr/share/nginx/html/version.json

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]

FROM ${NODE_IMAGE} AS notification-sink

ENV NODE_ENV=production
ENV NOTIFICATION_SINK_PORT=4080

WORKDIR /app

COPY --chown=node:node tooling/local-notification-sink.mjs ./local-notification-sink.mjs

USER node

EXPOSE 4080

CMD ["node", "local-notification-sink.mjs"]
