# docker/backend/Dockerfile
# Stage 1 — compile
FROM golang:1.25-bookworm AS builder
WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /app/backend .

# Stage 2 — runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/backend ./backend

RUN mkdir -p /tmp/sentry/streams data

EXPOSE 9305
ENV PORT=9305 \
    SENTRY_DATA_DIR=/app/data

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
    CMD wget -qO- http://localhost:9305/health || exit 1

CMD ["./backend"]
