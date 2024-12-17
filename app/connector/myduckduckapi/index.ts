// From original index.ts
import { start } from "@hasura/ndc-duckduckapi";
import { makeConnector, duckduckapi } from "@hasura/ndc-duckduckapi";
import * as path from "path";
import { DATABASE_SCHEMA } from "./functions";

const connectorConfig: duckduckapi = {
  dbSchema: DATABASE_SCHEMA,
  functionsFilePath: path.resolve(__dirname, "./functions.ts"),
  multitenantMode: true,
  oauthProviderName: "zendesk",
};

(async () => {
  const connector = await makeConnector(connectorConfig);
  start(connector);
})();
