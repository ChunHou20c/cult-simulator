# The PWA as a static nginx image. Build from the repo root:
#   docker build -f deploy/web.Dockerfile -t cult-simulator-web .
# Nakama connection settings are read at container start (see
# deploy/web/40-runtime-config.sh), so one image serves any server.
FROM node:22-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci
COPY scripts/ scripts/
COPY content/ content/
COPY apps/web/ apps/web/
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 deploy/web/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=builder --chown=101:101 /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
