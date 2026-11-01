# Builds the Go plugin with the plugin builder for the exact Nakama version,
# then copies it into the matching Nakama image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t cult-simulator-nakama .
ARG NAKAMA_VERSION=3.41.0
FROM heroiclabs/nakama-pluginbuilder:${NAKAMA_VERSION} AS builder
ENV GO111MODULE=on CGO_ENABLED=1
WORKDIR /backend
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN go build -buildvcs=false -trimpath -buildmode=plugin -o ./backend.so .

FROM heroiclabs/nakama:${NAKAMA_VERSION}
COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
COPY deploy/nakama.yml /nakama/data/nakama.yml
