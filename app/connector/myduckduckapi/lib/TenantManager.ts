import { setTimeout as delay } from "timers/promises";
import {
  schemaOrganizations,
  schemaBrands,
  schemaGroups,
  schemaUsers,
  schemaTickets,
} from "./schema";
import {
  getTenantDB,
  transaction,
  Database,
  DDNJobStatusV1,
} from "@hasura/ndc-duckduckapi";

const LOG_DEBUG = true;

// Configuration constants
const SYNC_INTERVAL = 1000 * 60 * 5;
const ERROR_BACKOFF_INTERVAL = 1000 * 60 * 2;
const ERROR_RETRY_COUNT = 3;

// Initial start time for first sync: 0 (from beginning of time)
const INITIAL_START_TIME = 0;

enum SyncState {
  Running,
  Interrupted,
  Stopped,
}

class SyncInterruptedError extends Error {
  constructor() {
    super("Sync interrupted");
    this.name = "SyncInterruptedError";
  }
}

type BooleanString = "true" | "false";

export class TenantManager {
  db!: Database;
  tenantToken: string | undefined;
  serviceUserId: string | undefined;
  isAdminUser: BooleanString | undefined;
  subdomain: string | undefined;
  baseUrl: string | undefined;

  status: DDNJobStatusV1 = {
    ok: false,
    message: "Login to connect to Zendesk",
  };

  syncState = SyncState.Stopped;

  constructor(public tenantId: string) {}

  async initDb() {
    this.db ||= await getTenantDB(this.tenantId);
  }

  async setUserConfig(token: string, config: any) {
    await this.initDb();

    const subdomain = config.subdomain;

    if (subdomain) {
      await this.db.run(
        `INSERT INTO ddn_tenant_state (key, value)
         VALUES ('subdomain', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        subdomain
      );
    }

    const { serviceUserId, isAdminUser } = await this.getServiceUserDetails(
      token,
      subdomain
    );

    await transaction(this.db, async (conn) => {
      await conn.run(
        `INSERT INTO ddn_tenant_state (key, value)
         VALUES ('accessToken', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        token
      );

      await conn.run(
        `INSERT INTO ddn_tenant_state (key, value)
         VALUES ('serviceUserId', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        serviceUserId
      );

      await conn.run(
        `INSERT INTO ddn_tenant_state (key, value)
         VALUES ('isAdminUser', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        isAdminUser
      );
    });
  }

  async readTenantState() {
    let reset = false;

    let tenantToken: string | undefined;
    let serviceUserId: string | undefined;
    let isAdminUser: BooleanString | undefined;
    let subdomain: string | undefined;

    await this.initDb();

    {
      const rows = await this.db.all(
        `SELECT value FROM ddn_tenant_state WHERE key = 'accessToken'`
      );

      if (rows[0].value) {
        tenantToken = rows[0].value;
      }
    }

    {
      const rows = await this.db.all(
        `SELECT value FROM ddn_tenant_state WHERE key = 'serviceUserId'`
      );

      if (rows[0].value) {
        serviceUserId = rows[0].value;
      }
    }

    {
      const rows = await this.db.all(
        `SELECT value FROM ddn_tenant_state WHERE key = 'isAdminUser'`
      );

      if (rows[0].value) {
        isAdminUser = rows[0].value;
      }
    }

    {
      const rows = await this.db.all(
        `SELECT value FROM ddn_tenant_state WHERE key = 'subdomain'`
      );

      if (rows[0].value) {
        subdomain = rows[0].value;
      }
    }

    if (this.serviceUserId && this.serviceUserId !== serviceUserId) {
      reset = true;
    }

    if (this.isAdminUser && this.isAdminUser !== isAdminUser) {
      reset = true;
    }

    if (this.subdomain && this.subdomain !== subdomain) {
      reset = true;
    }

    if (tenantToken) this.tenantToken = tenantToken;
    if (serviceUserId) this.serviceUserId = serviceUserId;
    if (isAdminUser) this.isAdminUser = isAdminUser;
    if (subdomain) this.subdomain = subdomain;

    this.baseUrl = subdomain
      ? `https://${this.subdomain}.zendesk.com`
      : undefined;

    if (reset) {
      await this.stopSync();
      await this.resetAllData();
    }
  }

  async run() {
    await this.readTenantState();

    if (this.syncState !== SyncState.Stopped) return;
    this.syncState = SyncState.Running;

    this.log("Starting sync loop");
    this.status = {
      ok: true,
      message: "Running",
    };

    try {
      // Continuous sync loop
      while (this.syncState === SyncState.Running) {
        if (this.isAdminUser === "true") {
          // Sync incremental models
          await this.syncIncremental("tickets");
          await this.syncIncremental("users");
        } else {
          // Sync list-cursor models
          await this.syncTickets();
          await this.syncUsers();
        }

        // Sync list-cursor models
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
      this.status = {
        ok: false,
        message: e instanceof Error ? e.message : "Unknown error",
      };
    } finally {
      this.syncState = SyncState.Stopped;
    }
  }

  async stopSync() {
    while (this.syncState !== SyncState.Stopped) {
      this.syncState = SyncState.Interrupted;
      this.status = {
        ok: false,
        message: "Restarting sync...",
      };
      await delay(1000);
    }
  }

  assertRunning() {
    if (this.syncState !== SyncState.Running) {
      throw new SyncInterruptedError();
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
      return `${this.baseUrl}/api/v2/incremental/${model}/cursor.json?start_time=${INITIAL_START_TIME}`;
    } else {
      return rows[0].cursor;
    }
  }

  // Process a single page from the incremental API for tickets or users
  async processPage(
    model: "tickets" | "users",
    url: string
  ): Promise<{ endOfStream: boolean; afterUrl?: string }> {
    const data = await this.fetchWithRetry(url);

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
   * Sync all users via list cursor API (using links.next).
   */
  async syncUsers() {
    this.log("Starting full list-cursor sync for users");

    // 1) Drop next table if exists
    await this.db.run("DROP TABLE IF EXISTS next_users");

    // 2) Create next table (assuming schemaUsers exists in schema.ts)
    await this.db.run(schemaUsers("next_users"));

    // 3 & 4) Fetch + insert into next_users page by page
    const endpoint = "users";
    let nextUrl:
      | string
      | null = `${this.baseUrl}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      // Fetch the page
      const data = await this.fetchWithRetry(nextUrl);
      const pageRecords = data?.[endpoint] ?? [];

      // Insert data for this page into the table
      await transaction(this.db, async (conn) => {
        for (const user of pageRecords) {
          const tagsStr = JSON.stringify(user.tags ?? []);
          await conn.run(
            `
          INSERT INTO next_users 
          (id, url, name, email, created_at, updated_at, time_zone, phone, organization_id, tags, details, notes, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            user.id,
            user.url,
            user.name ?? null,
            user.email ?? null,
            user.created_at ?? null,
            user.updated_at ?? null,
            user.iana_time_zone ?? null,
            user.phone ?? null,
            user.organization_id ?? null,
            tagsStr,
            user.details ?? null,
            user.notes ?? null,
            user.active ?? true
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

    // 5) Atomically swap old table with next_users
    await this.swapTables("users", "next_users");
    this.log("Finished sync for users");
  }

  /**
   * Sync all tickets via list cursor API (using links.next).
   */
  async syncTickets() {
    this.log("Starting full list-cursor sync for tickets");

    // 1) Drop next table if exists
    await this.db.run("DROP TABLE IF EXISTS next_tickets");

    // 2) Create next table (assuming schemaTickets exists in schema.ts)
    await this.db.run(schemaTickets("next_tickets"));

    // 3 & 4) Fetch + insert into next_tickets page by page
    const endpoint = "tickets";
    let nextUrl:
      | string
      | null = `${this.baseUrl}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      // Fetch the page
      const data = await this.fetchWithRetry(nextUrl);
      const pageRecords = data?.[endpoint] ?? [];

      // Insert data for this page into the table
      await transaction(this.db, async (conn) => {
        for (const ticket of pageRecords) {
          const tagsStr = JSON.stringify(ticket.tags ?? []);
          await conn.run(
            `
          INSERT INTO next_tickets 
          (url, id, subject, description, priority, status, type, via_channel, assignee_id, requester_id, submitter_id, group_id, organization_id, brand_id, created_at, updated_at, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            ticket.url,
            ticket.id,
            ticket.subject ?? null,
            ticket.description ?? null,
            ticket.priority ?? null,
            ticket.status ?? null,
            ticket.type ?? null,
            ticket.via?.channel ?? null,
            ticket.assignee_id ?? null,
            ticket.requester_id ?? null,
            ticket.submitter_id ?? null,
            ticket.group_id ?? null,
            ticket.organization_id ?? null,
            ticket.brand_id ?? null,
            ticket.created_at ?? null,
            ticket.updated_at ?? null,
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

    // 5) Atomically swap old table with next_tickets
    await this.swapTables("tickets", "next_tickets");
    this.log("Finished sync for tickets");
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
      | null = `${this.baseUrl}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      // Fetch the page
      const data = await this.fetchWithRetry(nextUrl);
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
      | null = `${this.baseUrl}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      const data = await this.fetchWithRetry(nextUrl);
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
      | null = `${this.baseUrl}/api/v2/${endpoint}.json?page[size]=100`;

    while (nextUrl) {
      const data = await this.fetchWithRetry(nextUrl);
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

  async getServiceUserDetails(
    token: string,
    subdomain: string
  ): Promise<{ serviceUserId: string; isAdminUser: BooleanString }> {
    const data = await fetchWithRetry(
      `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
      token,
      () => true,
      this.debug.bind(this)
    );
    return {
      serviceUserId: String(data?.user?.id),
      isAdminUser: data?.user?.role === "admin" ? "true" : "false",
    };
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

  /**
   * Truncates all known tables except ddn_tenant_state
   */
  private async resetAllData() {
    await transaction(this.db, async (conn) => {
      await conn.run("DELETE FROM tickets");
      await conn.run("DELETE FROM users");
      await conn.run("DELETE FROM organizations");
      await conn.run("DELETE FROM brands");
      await conn.run("DELETE FROM groups");
      await conn.run("DELETE FROM incremental_sync_cursors");
    });
  }

  log(...args: any[]) {
    console.log(`[${this.tenantId}]`, ...args);
  }

  debug(...args: any[]) {
    if (LOG_DEBUG) this.log(...args);
  }

  /**
   * Fetch with retry logic for rate limits
   */
  private async fetchWithRetry(url: string): Promise<any> {
    if (!this.tenantToken) {
      throw new Error("No tenant token");
    }

    return fetchWithRetry(
      url,
      this.tenantToken,
      this.assertRunning.bind(this),
      this.debug.bind(this)
    );
  }

  async cleanup() {
    try {
      // Stop any ongoing sync
      await this.stopSync();

      // Close the database connection if it exists
      if (this.db) {
        await this.db.close();
        this.db = undefined as any;
      }
    } catch (e) {
      console.error(`Error cleaning up tenant ${this.tenantId}:`, e);
    }
  }
}

async function fetchWithRetry(
  url: string,
  token: string,
  assertRunning: () => void | never,
  debug: (...args: any[]) => void
): Promise<any> {
  let retryCount = 0;

  let lastError: Error | null = null;

  while (retryCount < ERROR_RETRY_COUNT) {
    assertRunning();

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      // Rate limited
      const retryAfter = Number(response.headers.get("retry-after")) || 60;
      lastError = new Error(
        `Rate limited. Waiting for ${retryAfter} seconds...`
      );
      debug(lastError);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(
        `Error from Zendesk API: ${response.status} ${response.statusText}`
      );
      debug(lastError);
      retryCount++;
      await delay(ERROR_BACKOFF_INTERVAL);
      continue;
    }

    return await response.json();
  }

  throw lastError;
}
