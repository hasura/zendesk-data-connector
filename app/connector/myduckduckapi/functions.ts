import { JSONValue } from "@hasura/ndc-lambda-sdk";
import {
  exchangeZendeskOAuthCodeForToken,
  getTenantIdFromHeaders,
  ZENDESK_CLIENT_ID,
} from "./lib/lib";
import { TenantManager } from "./lib/TenantManager";
import {
  DDNJobStatusV1,
  DDNOAuthProviderCodeLoginRequestV1,
  DDNConnectorEndpointsConfigV1,
  DDNConfigResponseV1,
} from "@hasura/ndc-duckduckapi";

const tenants = new Map<string, TenantManager>();
function getTenant(tenantId: string): TenantManager {
  let tenant = tenants.get(tenantId);
  if (!tenant) {
    tenant = new TenantManager(tenantId);
    tenants.set(tenantId, tenant);
  }
  return tenant;
}

/**
 * $ddn.config
 *  @readonly
 */
export async function _ddnConfig(): Promise<DDNConfigResponseV1> {
  const config: DDNConnectorEndpointsConfigV1 = {
    version: 1,
    jobs: [
      {
        id: "my-zendesk-job",
        title: "Zendesk",
        functions: {
          status: {
            functionTag: "zendeskStatus",
          },
        },
        oauthProviders: [
          {
            id: "my-zendesk-provider",
            template: "zendesk",
            oauthCodeLogin: {
              functionTag: "zendeskLogin",
            },
            oauthDetails: {
              clientId: ZENDESK_CLIENT_ID,
              scopes: "read",
              pkceRequired: false,
            },
          },
        ],
      },
    ],
  };

  return {
    version: 1,
    config: JSON.stringify(config),
  };
}

/**
 *  $ddn.functions.zendeskStatus
 *  @readonly
 * */
export async function _ddnZendeskStatus(
  headers: JSONValue
): Promise<DDNJobStatusV1> {
  const tenantId = getTenantIdFromHeaders(headers);
  const tenant = getTenant(tenantId);

  return {
    ok: tenant.status.ok,
    message: tenant.status.message,
  };
}

/**
 * $ddn.functions.zendeskLogin
 */
export async function _ddnZendeskLogin(
  req: DDNOAuthProviderCodeLoginRequestV1,
  userConfig: string,
  headers: JSONValue
): Promise<DDNJobStatusV1> {
  const tenantId = getTenantIdFromHeaders(headers);
  const tenant = getTenant(tenantId);

  try {
    const token = await exchangeZendeskOAuthCodeForToken(req);
    const config = JSON.parse(userConfig);

    await tenant.setUserConfig(token, config);

    tenant.run();

    return {
      ok: true,
      message: "Setting up...",
    };
  } catch (e) {
    return {
      ok: false,
      message: `${e}`,
    };
  }
}
