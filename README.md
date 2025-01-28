# Zendesk data connector

## Setup

```bash
cp .env.development .env
ddn project init --with-promptql
ddn supergraph build local
ddn run docker-start-watch

cd app/connector/myduckduckapi
npm link @hasura/ndc-duckduckapi # to the multitenant development version at https://github.com/hasura/ndc-duckduckapi/pull/12
./start-dev.sh
```

## Usage

Use this console https://github.com/hasura/v3-console/pull/1301

On the OAuth Playground login then run the sync job

Use the promptql playground
