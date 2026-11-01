#!/usr/bin/env sh
# Builds the plugin with the Nakama plugin builder and (re)starts a local
# Nakama + Postgres in Docker. DAY_SECONDS=300 gives 5-minute Days.
#   DAY_SECONDS=300 scripts/dev-server.sh
set -e
cd "$(dirname "$0")/.."
NAKAMA_VERSION=${NAKAMA_VERSION:-3.41.0}
mkdir -p deploy/build
MODCACHE=$(cd server && go env GOMODCACHE 2>/dev/null || echo "$HOME/go/pkg/mod")
docker run --rm -v "$PWD/server:/backend" -v "$MODCACHE:/go/pkg/mod" -w /backend \
  --entrypoint sh heroiclabs/nakama-pluginbuilder:$NAKAMA_VERSION \
  -c 'go build -buildvcs=false -trimpath -buildmode=plugin -o /tmp/backend.so . && cp /tmp/backend.so /backend/backend.so'
mv server/backend.so deploy/build/backend.so
docker network create cs-net >/dev/null 2>&1 || true
if ! docker ps --format '{{.Names}}' | grep -q '^cs-pg$'; then
  docker rm -f cs-pg >/dev/null 2>&1 || true
  docker run -d --name cs-pg --network cs-net -e POSTGRES_DB=nakama -e POSTGRES_USER=nakama -e POSTGRES_PASSWORD=localdev postgres:16-alpine >/dev/null
  sleep 5
fi
docker rm -f cs-nakama >/dev/null 2>&1 || true
docker run -d --name cs-nakama --network cs-net -p 127.0.0.1:7350:7350 -p 127.0.0.1:7351:7351 \
  -v "$PWD/deploy/build:/nakama/data/modules" -v "$PWD/content:/nakama/data/content:ro" \
  -v "$PWD/deploy/nakama.yml:/nakama/data/nakama.yml:ro" \
  --entrypoint /bin/sh heroiclabs/nakama:$NAKAMA_VERSION -ecx \
  "/nakama/nakama migrate up --database.address nakama:localdev@cs-pg:5432/nakama && exec /nakama/nakama --config /nakama/data/nakama.yml --database.address nakama:localdev@cs-pg:5432/nakama --runtime.env DAY_SECONDS=${DAY_SECONDS:-86400}" >/dev/null
echo "Nakama starting on http://127.0.0.1:7350 (console on 7351, admin/password)"
