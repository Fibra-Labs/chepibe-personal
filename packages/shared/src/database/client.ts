import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "./schema";

export interface DbWithClient {
  db: ReturnType<typeof drizzle<typeof schema, Client>>;
  client: Client;
}

export async function createDb(config: { url: string; authToken?: string }): Promise<DbWithClient> {
  const clientConfig: { url: string; authToken?: string } = { url: config.url };
  if (config.authToken) {
    clientConfig.authToken = config.authToken;
  }
  const client = createClient(clientConfig);

  // DELETE journal mode prevents WAL auto-checkpoint from changing the
  // database file inode on macOS Docker bind mounts (osxfs).  WAL's
  // checkpoint rewrites the main DB file, which can alter the inode and
  // trigger SQLITE_READONLY_DBMOVED (1032), permanently breaking the
  // connection.  Since this app is single-process, WAL's concurrent-read
  // advantage is unused — DELETE mode is strictly better here.
  await client.execute("PRAGMA journal_mode=DELETE");
  await client.execute("PRAGMA busy_timeout=5000");

  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = Awaited<ReturnType<typeof createDb>>["db"];
export { eq, and, inArray };