import { JSONValue } from "@hasura/ndc-lambda-sdk";
// import { GMail, GoogleCalendar } from "@hasura/ndc-duckduckapi/services";
import {
  getOAuthCredentialsFromHeader,
  getTenantDB,
  transaction,
  Connection,
  Database,
  getTenants,
  Tenant,
  TenantToken,
  getTenantById,
} from "@hasura/ndc-duckduckapi";

import { setTimeout as delay } from "timers/promises";

// Configuration constants
const SYNC_INTERVAL = 1000 * 60 * 5;
const ERROR_BACKOFF_INTERVAL = 1000 * 60 * 2;
const ERROR_RETRY_COUNT = 3;

// API constants
const ZENDESK_BASE_URL = process.env.ZENDESK_BASE_URL as string;

// Initial start time for first sync: 0 (from beginning of time)
const INITIAL_START_TIME = 0;

const LOG_DEBUG = true;

export const DATABASE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      subject TEXT,
      description TEXT,
      priority TEXT,
      status TEXT,
      type TEXT,
      via_channel TEXT,
      assignee_id BIGINT,
      requester_id BIGINT,
      submitter_id BIGINT,
      group_id BIGINT,
      organization_id BIGINT,
      brand_id BIGINT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT,
      email TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      time_zone TEXT,
      phone TEXT,
      organization_id BIGINT,
      tags TEXT,
      details TEXT,
      notes TEXT,
      active BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS incremental_sync_cursors (
      model TEXT PRIMARY KEY,
      cursor TEXT
    );

    ${schemaOrganizations("organizations")}

    ${schemaBrands("brands")}

    ${schemaGroups("groups")}
  `;

function schemaOrganizations(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT,
      details TEXT,
      notes TEXT,
      group_id BIGINT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      domain_names TEXT,
      tags TEXT
    );
  `;
}

function schemaBrands(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT,
      brand_url TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
  `;
}

function schemaGroups(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT,
      description TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );
  `;
}

class TenantManager implements Tenant {
  db!: Database;
  syncState: string = "starting...";
  tenantToken = "";

  running: boolean = false;

  constructor(public tenantId: string) {}

  async run() {
    if (this.running) return;
    this.running = true;

    this.db ||= await getTenantDB(this.tenantId);

    this.syncState = "running";

    try {
      // Continuous sync loop
      this.log("Starting sync loop");
      while (true) {
        // 1) Sync incremental models (tickets, users)
        await this.syncIncremental("tickets");
        await this.syncIncremental("users");

        // 2) Sync list-cursor models
        await this.syncOrganizations();
        await this.syncBrands();
        await this.syncGroups();

        // Wait some time before repeating
        this.log(
          `Completed sync. Waiting for ${SYNC_INTERVAL} seconds before next sync...`
        );
        await delay(SYNC_INTERVAL);
      }
    } catch (e) {
      this.log("Error in sync loop", e);
      this.running = false;
      this.syncState = "error";
    }
  }

  // Sync function for either "tickets" or "users"
  async syncIncremental(model: "tickets" | "users") {
    this.log("Syncing", model);

    let url = await this.getNextUrl(model);
    while (url) {
      // Fetch one page and process
      const { endOfStream, afterUrl } = await this.processPage(model, url);

      this.debug("Processed page", model, "done:", endOfStream);

      if (endOfStream) {
        // We've reached the end of the current incremental stream. Save the afterUrl (could be null).
        if (afterUrl) {
          await this.saveCursor(model, afterUrl);
        } else {
          // No after_url despite not end_of_stream is unusual, but handle gracefully
          break;
        }
        // Break out to wait until next run
        break;
      } else {
        // If not end_of_stream, we have a next afterUrl
        if (afterUrl) {
          await this.saveCursor(model, afterUrl);
          url = afterUrl;
        } else {
          // If there's no afterUrl, error out
          throw new Error("No afterUrl found");
        }
      }
    }
  }

  // Retrieve the next URL to fetch from for a given model
  async getNextUrl(model: "tickets" | "users"): Promise<string> {
    const rows = await this.db.all(
      `SELECT cursor FROM incremental_sync_cursors WHERE model = ?`,
      model
    );

    if (rows.length === 0 || !rows[0].cursor) {
      // No cursor stored yet or empty, start from initial start_time
      this.debug("First sync for", model);
      return `${ZENDESK_BASE_URL}/api/v2/incremental/${model}/cursor.json?start_time=${INITIAL_START_TIME}`;
    } else {
      return rows[0].cursor;
    }
  }

  // Process a single page from the incremental API for tickets or users
  async processPage(
    model: "tickets" | "users",
    url: string
  ): Promise<{ endOfStream: boolean; afterUrl?: string }> {
    const data = await fetchWithRetry(url, this.tenantToken);

    let ret: { endOfStream: boolean; afterUrl?: string } = {
      endOfStream: true,
    };

    await transaction(this.db, async (conn) => {
      if (model === "tickets") {
        const tickets = (data.tickets ?? []) as any[];
        for (const t of tickets) {
          // Directly reference fields in t
          const tagsStr = t.tags ? JSON.stringify(t.tags) : JSON.stringify([]);

          await conn.run(
            `INSERT INTO tickets 
          (url,id,subject,description,priority,status,type,via_channel,assignee_id,requester_id,submitter_id,group_id,organization_id,brand_id,created_at,updated_at,tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             url=excluded.url,
             subject=excluded.subject,
             description=excluded.description,
             priority=excluded.priority,
             status=excluded.status,
             type=excluded.type,
             via_channel=excluded.via_channel,
             assignee_id=excluded.assignee_id,
             requester_id=excluded.requester_id,
             submitter_id=excluded.submitter_id,
             group_id=excluded.group_id,
             organization_id=excluded.organization_id,
             brand_id=excluded.brand_id,
             created_at=excluded.created_at,
             updated_at=excluded.updated_at,
             tags=excluded.tags
          `,
            t.url,
            t.id,
            t.subject,
            t.description,
            t.priority,
            t.status,
            t.type,
            t.via?.channel || null,
            t.assignee_id,
            t.requester_id,
            t.submitter_id,
            t.group_id,
            t.organization_id,
            t.brand_id,
            t.created_at,
            t.updated_at,
            tagsStr
          );
        }

        const endOfStream = data.end_of_stream ?? true;
        const afterUrl = data.after_url ?? undefined;
        ret = { endOfStream, afterUrl };
      } else if (model === "users") {
        const users = (data.users ?? []) as any[];
        for (const u of users) {
          const tagsStr = u.tags ? JSON.stringify(u.tags) : JSON.stringify([]);

          await conn.run(
            `INSERT INTO users 
          (id,url,name,email,created_at,updated_at,time_zone,phone,organization_id,tags,details,notes,active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             url=excluded.url,
             name=excluded.name,
             email=excluded.email,
             created_at=excluded.created_at,
             updated_at=excluded.updated_at,
             time_zone=excluded.time_zone,
             phone=excluded.phone,
             organization_id=excluded.organization_id,
             tags=excluded.tags,
             details=excluded.details,
             notes=excluded.notes,
             active=excluded.active
          `,
            u.id,
            u.url,
            u.name,
            u.email,
            u.created_at,
            u.updated_at,
            u.iana_time_zone,
            u.phone,
            u.organization_id,
            tagsStr,
            u.details,
            u.notes,
            u.active
          );
        }

        const endOfStream = data.end_of_stream ?? true;
        const afterUrl = data.after_url ?? undefined;
        ret = { endOfStream, afterUrl };
      }
    });

    return ret;
  }

  // Store the after_url for a model
  async saveCursor(model: "tickets" | "users", afterUrl: string) {
    await transaction(this.db, async (conn) => {
      await conn.run(
        `INSERT INTO incremental_sync_cursors (model, cursor)
       VALUES (?, ?)
       ON CONFLICT(model) DO UPDATE SET cursor=excluded.cursor`,
        model,
        afterUrl
      );
    });
  }

  /**
   * Sync all organizations via list cursor API (using links.next).
   */
  async syncOrganizations() {
    this.log("Starting full list-cursor sync for organizations");

    // 1) Drop next table if exists
    await this.db.run("DROP TABLE IF EXISTS next_organizations");

    // 2) Create next table
    await this.db.run(schemaOrganizations("next_organizations"));

    // 3 & 4) Fetch + insert into next_organizations page by page
    const endpoint = "organizations";
    let nextUrl:
      | string
      | null = `${ZENDESK_BASE_URL}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      // Fetch the page
      const data = await fetchWithRetry(nextUrl, this.tenantToken);
      const pageRecords = data?.[endpoint] ?? [];

      // Insert data for this page into the table
      await transaction(this.db, async (conn) => {
        for (const org of pageRecords) {
          const domainNamesStr = JSON.stringify(org.domain_names ?? []);
          const tagsStr = JSON.stringify(org.tags ?? []);
          await conn.run(
            `
            INSERT INTO next_organizations
            (id, url, name, details, notes, group_id, created_at, updated_at, domain_names, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            org.id,
            org.url,
            org.name ?? null,
            org.details ?? null,
            org.notes ?? null,
            org.group_id ?? null,
            org.created_at ?? null,
            org.updated_at ?? null,
            domainNamesStr,
            tagsStr
          );
        }
      });

      // Check if there is another page
      if (data.meta?.has_more) {
        nextUrl = data.links?.next ?? null;
        if (!nextUrl) {
          this.debug(
            "Warning: 'has_more' is true but links.next is null. Stopping pagination."
          );
          break;
        }
      } else {
        nextUrl = null;
      }
    }

    // 5) Atomically swap old table with next_organizations
    await this.swapTables("organizations", "next_organizations");
    this.log("Finished sync for organizations");
  }

  /**
   * Sync all brands
   */
  async syncBrands() {
    this.log("Starting full list-cursor sync for brands");

    // 1) Drop next table if exists
    await this.db.run("DROP TABLE IF EXISTS next_brands");

    // 2) Create next table
    await this.db.run(schemaBrands("next_brands"));

    // 3 & 4) Fetch + insert into next_brands page by page
    const endpoint = "brands";
    let nextUrl:
      | string
      | null = `${ZENDESK_BASE_URL}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      const data = await fetchWithRetry(nextUrl, this.tenantToken);
      const pageRecords = data?.[endpoint] ?? [];

      // Insert each page
      await transaction(this.db, async (conn) => {
        for (const brand of pageRecords) {
          await conn.run(
            `
            INSERT INTO next_brands
            (id, url, name, brand_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
            brand.id,
            brand.url,
            brand.name ?? null,
            brand.brand_url ?? null,
            brand.created_at ?? null,
            brand.updated_at ?? null
          );
        }
      });

      if (data.meta?.has_more) {
        nextUrl = data.links?.next ?? null;
        if (!nextUrl) {
          this.debug(
            "Warning: 'has_more' is true but links.next is null. Stopping pagination."
          );
          break;
        }
      } else {
        nextUrl = null;
      }
    }

    // 5) Atomically swap old table
    await this.swapTables("brands", "next_brands");
    this.log("Finished sync for brands");
  }

  /**
   * Sync all groups
   */
  async syncGroups() {
    this.log("Starting full list-cursor sync for groups");

    // 1) Drop next table if exists
    await this.db.run("DROP TABLE IF EXISTS next_groups");

    // 2) Create next table
    await this.db.run(schemaGroups("next_groups"));

    // 3 & 4) Fetch + insert page by page
    const endpoint = "groups";
    let nextUrl:
      | string
      | null = `${ZENDESK_BASE_URL}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      const data = await fetchWithRetry(nextUrl, this.tenantToken);
      const pageRecords = data?.[endpoint] ?? [];

      await transaction(this.db, async (conn) => {
        for (const grp of pageRecords) {
          await conn.run(
            `
            INSERT INTO next_groups
            (id, url, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
            grp.id,
            grp.url,
            grp.name ?? null,
            grp.description ?? null,
            grp.created_at ?? null,
            grp.updated_at ?? null
          );
        }
      });

      if (data.meta?.has_more) {
        nextUrl = data.links?.next ?? null;
        if (!nextUrl) {
          this.debug(
            "Warning: 'has_more' is true but links.next is null. Stopping pagination."
          );
          break;
        }
      } else {
        nextUrl = null;
      }
    }

    // 5) Swap
    await this.swapTables("groups", "next_groups");
    this.log("Finished sync for groups");
  }

  /**
   * Atomically drop the old table and rename the new table in a transaction.
   */
  async swapTables(oldName: string, newName: string) {
    await transaction(this.db, async (conn) => {
      // Drop the old table if it exists
      await conn.run(`DROP TABLE IF EXISTS ${oldName}`);
      // Rename new table to old table name
      await conn.run(`ALTER TABLE ${newName} RENAME TO ${oldName}`);
    });
  }

  log(...args: any[]) {
    console.log(`[${this.tenantId}]`, ...args);
  }

  debug(...args: any[]) {
    if (LOG_DEBUG) this.log(...args);
  }
}

/**
 * DDN JOBS
 */

const OAUTH_PROVIDER_NAME = "zendesk";

/**
 * $ddn.jobs.zendesk-loader.init
 */
export async function __dda_zendesk_loader_init(
  headers: JSONValue
): Promise<string> {
  const token =
    getOAuthCredentialsFromHeader(headers)?.[OAUTH_PROVIDER_NAME]?.access_token;

  if (!token) {
    return `Error in getting the ${OAUTH_PROVIDER_NAME} oauth credentials. Login to ${OAUTH_PROVIDER_NAME}?`;
  }

  const tenantId = await getServiceUserId(token);

  if (!tenantId) {
    return `Error in getting the ${OAUTH_PROVIDER_NAME} user id. Login to ${OAUTH_PROVIDER_NAME}?`;
  }

  const tenant =
    (getTenantById(tenantId) as TenantManager) ?? new TenantManager(tenantId);

  tenant.tenantToken = token;

  tenant.run();

  getTenants().set(token, tenant);

  console.log("loader init tenant", tenantId);

  return "starting";
}

/**
 *  $ddn.jobs.zendesk-loader.status
 *  @readonly
 * */
export async function __dda_zendesk_loader_status(
  headers: JSONValue
): Promise<string> {
  const token =
    getOAuthCredentialsFromHeader(headers)?.[OAUTH_PROVIDER_NAME]?.access_token;

  if (!token) {
    return `Error in getting the ${OAUTH_PROVIDER_NAME} oauth credentials. Login to ${OAUTH_PROVIDER_NAME}?`;
  }

  const tenant = getTenants().get(token);

  return tenant?.syncState ?? "stopped";
}

// Fetch with retry logic for rate limits
async function fetchWithRetry(url: string, tenantToken: string): Promise<any> {
  let retryCount = 0;

  while (retryCount < ERROR_RETRY_COUNT) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      // Rate limited
      const retryAfter = Number(response.headers.get("retry-after")) || 60;
      if (LOG_DEBUG)
        console.log(`Rate limited. Waiting for ${retryAfter} seconds...`);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      if (LOG_DEBUG)
        console.error(
          `Error from Zendesk API: ${response.status} ${response.statusText}`
        );
      retryCount++;
      await delay(ERROR_BACKOFF_INTERVAL);
      continue;
    }

    return await response.json();
  }

  throw new Error("Failed to fetch data after retries");
}

async function getServiceUserId(tenantToken: string): Promise<string> {
  const data = await fetchWithRetry(
    `${ZENDESK_BASE_URL}/api/v2/users/me.json`,
    tenantToken
  );
  return data?.user?.id;
}
