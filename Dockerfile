# Build Rust binary
FROM rust:1.90 AS rust-builder
WORKDIR /app

# Install sccache prebuilt binary
RUN case "$(uname -m)" in \
    x86_64) ARCH=x86_64 ;; \
    aarch64) ARCH=aarch64 ;; \
    *) echo "Unsupported architecture: $(uname -m)" && exit 1 ;; \
    esac && \
    curl -L "https://github.com/mozilla/sccache/releases/download/v0.10.0/sccache-v0.10.0-${ARCH}-unknown-linux-musl.tar.gz" | \
    tar -xz --strip-components=1 -C /usr/local/bin/

# Copy source files
COPY Cargo.toml Cargo.lock ./
COPY locales/ ./locales/
COPY migrations/ ./migrations/
COPY src/ ./src/

# Build with sccache
ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_DIR=/sccache
ENV SCCACHE_CACHE_SIZE="10G"
ENV DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5433/oeee_cafe

# Baked in via option_env! and used to version static asset URLs, so a deploy
# invalidates browser and CDN caches and nothing else does. Without it the
# server falls back to its start time, which is correct but re-downloads
# assets on every restart.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

# `cargo build --release` already builds both bin targets. /app/target is a
# cache mount, so anything needed later must be copied out inside this RUN.
RUN --mount=type=cache,target=/sccache \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release && \
    sccache --show-stats && \
    cp /app/target/release/oeee-cafe /app/oeee-cafe && \
    cp /app/target/release/cli /app/cli

# Build neo-cucumber
FROM node:24-slim AS node-builder-neo-cucumber
WORKDIR /app/neo-cucumber
COPY neo-cucumber/package.json neo-cucumber/pnpm-lock.yaml neo-cucumber/ ./
RUN npm install --global corepack@latest
RUN corepack enable pnpm
RUN corepack use pnpm@latest-10
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# Build runtime image
FROM ubuntu:25.10
WORKDIR /app
# curl is what the compose healthcheck shells out to.
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY tegaki/ ./tegaki/
COPY neo/dist/neo.css neo/dist/neo.js ./neo/dist/
COPY locales/ ./locales/
COPY static/ ./static/
COPY templates/ ./templates/
COPY --from=rust-builder /app/oeee-cafe ./
# Admin/ops commands, e.g.
#   docker exec oeee-cafe ./cli -c config/config.toml set-role <login_name> admin
COPY --from=rust-builder /app/cli ./
COPY --from=node-builder-neo-cucumber /app/neo-cucumber/dist/ ./neo-cucumber/dist/
EXPOSE 3000
CMD ["./oeee-cafe", "config/config.toml"]