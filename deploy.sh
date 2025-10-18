#!/bin/zsh

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
export DATABASE_URL=postgresql:///oeee_cafe

git pull
cargo sqlx prepare
docker-compose up -d --build --remove-orphans
