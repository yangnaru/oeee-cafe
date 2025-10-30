#!/bin/zsh

# Exit on error, undefined variables, and pipe failures
set -euo pipefail

# Enable BuildKit for Docker builds
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Cleanup function
cleanup() {
    echo "==> Cleaning up build database..."
    docker rm -f oeee-cafe-build-db 2>/dev/null || true
}

# Set trap to cleanup on exit
trap cleanup EXIT

echo "==> Pulling latest code from git..."
if ! git pull; then
    echo "ERROR: git pull failed"
    exit 1
fi

echo "==> Ensuring build network exists..."
docker network create oeee-cafe-network 2>/dev/null || true

echo "==> Starting temporary PostgreSQL container for build..."
if ! docker run -d \
    --name oeee-cafe-build-db \
    -p 5433:5432 \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=oeee_cafe \
    postgres:18; then
    echo "ERROR: Failed to start build database"
    exit 1
fi

echo "==> Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec oeee-cafe-build-db pg_isready -U postgres >/dev/null 2>&1; then
        echo "PostgreSQL is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "ERROR: PostgreSQL did not become ready in time"
        exit 1
    fi
    sleep 1
done

echo "==> Running migrations..."
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/oeee_cafe
if ! sqlx migrate run; then
    echo "ERROR: migrations failed"
    exit 1
fi

echo "==> Building and deploying with Docker Compose..."
if ! docker compose up -d --build --remove-orphans; then
    echo "ERROR: docker compose failed"
    exit 1
fi

echo "==> Deployment successful!"
echo "==> Checking container status..."
docker compose ps
