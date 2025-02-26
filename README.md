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
ddn console --local
```

## Deploy and Share

```bash
ddn supergraph build create
ddn console
```

# Zendesk App Console

## Quickstart

- Click on the SaaS tab on the left nav bar
- Wait a moment for the Zendesk integration to pop up
- Click on the Zendesk integration
- Click on the Edit button, add your Zendesk subdomain, and hit Save
- Click on the Login button, and provide your Zendesk credentials to log in with Zendesk
- Your data is now being synced
- Head over to the PromptQL tab to act on your data

## Sample questions

Sync Status (Click on Memory Artifacts in the top right.)

```
Created at times for the most recent ticket and user. In a single artefact, show the latest times for each.

Run this in a loop forever and update every 5 seconds.
```

### Quick wins and summaries

Count open tickets by assignee

```
Count open tickets by assignee.
```

On which day of the week are tickets created

```
Create a histogram for count of tickets by created day of the week. Present the results as a table artefact. Use ASCII art to create a graph and present it as a text artefact.
```

Average time to resolution by assignee

```
For tickets opened in the last 4 months which are already closed, identify the average time to resolution grouped by the assignee. Present the results using ascii art in a text artefact.
```

### Deep Analysis

Executive summary for top organization's open tickets

```
Which organization has the most open tickets? Retrieve the 20 most recent open tickets for this org. Combine the titles and descriptions into a text artefact. Summarize the text into a brief executive summary. In particular highlight next actions.
```

Workload balancing

```
For the 100 most recent open tickets, classify each into HIGH (10 points), MEDIUM (5 points), or LOW (2 points) effort; and show this as a table. Find the total effort score per assignee over these tickets. Show the result as a table, and as ascii art in a text artefact.
```

How can I use AI to answer my support tickets

```
Combine titles and descriptions from the most recent 100 tickets into a text artefact. Use the summarize primitive to identify the top 5 categories of tickets. Then, for the most recent 100 tickets, classify each ticket into one of the categories or "other", and classify each ticket based on whether it can be answered by AI or not. Summarize the statistics for categories. For each named category summarize the titles and descriptions for those tickets that can be answered by AI, and present each summary as a text artefact.
```

## How it works

The system maintains an isolated database and sync loop for every user, so that user data and state is isolated.

Your Zendesk data is synced to a user specific database, and is used by PromptQL to run queries.

Why do I only see some tickets?
If you have role admin in Zendesk, all tickets are synced.
For other roles, [archived tickets](https://support.zendesk.com/hc/en-us/articles/4408887617050-About-ticket-archiving) are not synced.

Only data that your Zendesk user can access is synced to your database instance.

# Hasura PromptQL app deployment

edit the .env.cloud file

ddn supergraph build create --no-build-connectors

don't merge this branch to master
rebase this branch on top of master

