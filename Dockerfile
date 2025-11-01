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

RUN --mount=type=cache,target=/sccache,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release && \
    sccache --show-stats

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
RUN apt-get update && apt-get install ca-certificates -y
COPY tegaki/ ./tegaki/
COPY neo/dist/neo.css neo/dist/neo.js ./neo/dist/
COPY locales/ ./locales/
COPY static/ ./static/
COPY templates/ ./templates/
COPY --from=rust-builder /app/target/release/oeee-cafe ./
COPY --from=node-builder-neo-cucumber /app/neo-cucumber/dist/ ./neo-cucumber/dist/
EXPOSE 3000
CMD ["./oeee-cafe", "config/config.toml"]