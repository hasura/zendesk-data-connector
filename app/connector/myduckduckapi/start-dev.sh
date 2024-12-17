#!/bin/bash

set -eux

export ZENDESK_BASE_URL=https://hasurahelp.zendesk.com
export DUCKDB_PATH="$PWD/duckdb-persist"

export HASURA_CONNECTOR_PORT=6514

export DUCKDB_URL="duck.db"
export HASURA_SERVICE_TOKEN_SECRET="67h_CDH5_bWij6YP7C9_9w=="
export OTEL_EXPORTER_OTLP_ENDPOINT="http://local.hasura.dev:4387"
export OTEL_SERVICE_NAME="app_myduckduckapi"

npm run watch