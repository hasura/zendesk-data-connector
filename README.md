# Zendesk data connector

## Setup services

```bash
cp .env.development .env

# edit .env to set the zendesk oauth client id and secret

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
