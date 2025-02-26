#!/bin/bash

set -euo pipefail

function setup() {
  DEPLOY_DIR="$HOME/promptql-apps/zendesk-data-connector"

  mkdir -p "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"

  if [ ! -d "$DEPLOY_DIR/.git" ]; then
      git clone git@github.com:hasura/zendesk-data-connector.git .
  fi

  git checkout hasura/prodapp
}

function dc() {
    docker compose -f compose.prod.yaml -p zendesk "$@"
}

git fetch
git reset --hard origin/hasura/prodapp

cd app/connector/myduckduckapi

dc down --remove-orphans

dc up --build -d
