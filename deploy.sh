#!/bin/zsh

# Exit on error, undefined variables, and pipe failures
set -euo pipefail

# Enable BuildKit for Docker builds
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
export DATABASE_URL=postgresql:///oeee_cafe

echo "==> Pulling latest code from git..."
if ! git pull; then
    echo "ERROR: git pull failed"
    exit 1
fi

echo "==> Preparing SQLx metadata..."
if ! cargo sqlx prepare; then
    echo "ERROR: cargo sqlx prepare failed"
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
