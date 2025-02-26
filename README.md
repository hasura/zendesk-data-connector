# Zendesk data connector

## Setup services

```bash
cp .env.development .env

# edit .env to set the zendesk environment variables
# (required) ZENDESK_CLIENT_ID=
# (optional) ZENDESK_CLIENT_SECRET=
# (optional) ZENDESK_PKCE_REQUIRED=true

ddn supergraph build local

ddn project init

ddn run docker-start
```

## Usage

On the OAuth Playground tab
- Login using the zendesk OAuth provider
- Run the sync job 'zendesk-loader'

Use the PromptQL playground

## Deploy and Share

```bash
ddn supergraph build create
ddn console
```

On the OAuth Playground tab
- Add the OAuth client provider
- Login and run the sync job

Use the PromptQL playground

# Hasura PromptQL app deployment

edit the .env.cloud file

ddn supergraph build create --no-build-connectors

don't merge this branch to master
use `git pull --rebase` to update the branch