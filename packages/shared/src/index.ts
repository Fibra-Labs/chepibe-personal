import { createClient as createLibsqlClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql, eq, and, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

export { eq, and, inArray };

export const whatsappSessions = sqliteTable("whatsapp_sessions", {
  id: text("id").primaryKey(),
  phoneNumber: text("phone_number"),
  status: text("status").default("pending").notNull(),
  creds: text("creds"),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`).notNull(),
});

export const whatsappSessionKeys = sqliteTable("whatsapp_session_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  keyType: text("key_type").notNull(),
  keyId: text("key_id").notNull(),
  keyData: text("key_data"),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`).notNull(),
}, (table) => [
  uniqueIndex("uq_session_keys_type_id").on(table.sessionId, table.keyType, table.keyId),
]);

const schema = { whatsappSessions, whatsappSessionKeys };

export type Db = ReturnType<typeof drizzle<typeof schema, Client>>;

export interface DbWithClient {
  db: Db;
  client: Client;
}

export async function createDb(config: { url: string; authToken?: string }): Promise<DbWithClient> {
  const clientConfig: { url: string; authToken?: string } = { url: config.url };
  if (config.authToken) {
    clientConfig.authToken = config.authToken;
  }
  const client = createLibsqlClient(clientConfig);

  if (config.url.startsWith("file")) {
    await client.execute("PRAGMA journal_mode=DELETE");
    await client.execute("PRAGMA busy_timeout=5000");
  }

  const db = drizzle(client, { schema });
  return { db, client };
}

export async function runMigrations(db: Db, migrationsFolder = "./drizzle"): Promise<boolean> {
  try {
    await migrate(db as any, { migrationsFolder });
    return true;
  } catch (err) {
    throw new Error(`Database migrations failed from "${migrationsFolder}": ${err}`);
  }
}
