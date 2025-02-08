export const DATABASE_SCHEMA = `
    ${schemaTickets("tickets")}

    ${schemaUsers("users")}

    CREATE TABLE IF NOT EXISTS incremental_sync_cursors (
      model TEXT PRIMARY KEY,
      cursor TEXT
    );

    CREATE TABLE IF NOT EXISTS ddn_tenant_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    ${schemaOrganizations("organizations")}

    ${schemaBrands("brands")}

    ${schemaGroups("groups")}
  `;

export function schemaOrganizations(tableName: string) {
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

export function schemaBrands(tableName: string) {
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

export function schemaGroups(tableName: string) {
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

export function schemaUsers(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
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
  `;
}

export function schemaTickets(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
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
  `;
}
