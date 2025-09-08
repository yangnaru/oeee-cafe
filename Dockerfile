# Build Rust binary
FROM rust:1.89 AS rust-builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY .sqlx/ ./.sqlx/
COPY locales/ ./locales/
COPY migrations/ ./migrations/
COPY src/ ./src/
RUN cargo build --release

# Build cucumber
FROM node:24-slim AS node-builder-cucumber
WORKDIR /app/cucumber
COPY cucumber/package.json cucumber/package-lock.json cucumber/tsconfig.json cucumber/ ./
RUN npm ci
RUN npx tsc

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
COPY --from=node-builder-cucumber /app/cucumber/cucumber.js ./cucumber/
EXPOSE 3000
CMD ["./oeee-cafe", "config.toml"]