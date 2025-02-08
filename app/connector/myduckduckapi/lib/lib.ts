import { JSONValue, InternalServerError } from "@hasura/ndc-lambda-sdk";
import { exchangeOAuthCodeForToken } from "@hasura/ndc-duckduckapi";

export const ZENDESK_CLIENT_ID = process.env.ZENDESK_CLIENT_ID!;
if (!ZENDESK_CLIENT_ID) {
  throw new Error("ZENDESK_CLIENT_ID is not set");
}

export function getTenantIdFromHeaders(headers: JSONValue): string {
  if (!headers) throw new InternalServerError("Header forwarding not enabled");

  const tenantIdPropertyName =
    process.env.HEADERS_TENANT_ID_PROPERTY_NAME ?? "tenantId";

  return (headers.value as any)?.[tenantIdPropertyName.toLowerCase()];
}

export async function exchangeZendeskOAuthCodeForToken(req: {
  code: string;
  tokenEndpoint: string;
  codeVerifier?: string;
  redirectUri: string;
}) {
  const data = await exchangeOAuthCodeForToken({
    ...req,
    clientId: ZENDESK_CLIENT_ID,
    clientSecret: process.env.ZENDESK_CLIENT_SECRET,
  });

  return data.access_token as string;
}
