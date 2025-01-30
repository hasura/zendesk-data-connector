# Zendesk data connector

## Setup services

```bash
cp .env.development .env

# edit .env to set the ZENDESK_BASE_URL

ddn supergraph build local

ddn project init

ddn run docker-start
```

## Setup OAuth client

Create a new OAuth client on the Zendesk admin page
https://YOUR_ZENDESK_SUBDOMAIN.zendesk.com/admin/apps-integrations/apis/zendesk-api/oauth_clients

Open the console `ddn console --local`

On the OAuth Playground tab, add the OAuth client provider
- Name: 'zendesk'
- Scopes: 'read'
- Authorization URL: https://YOUR_ZENDESK_SUBDOMAIN.zendesk.com/oauth/authorizations/new
- Token URL: https://YOUR_ZENDESK_SUBDOMAIN.zendesk.com/oauth/tokens
- PKCE: 'true'
- Client ID and Secret: as configured on the Zendesk admin page

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
