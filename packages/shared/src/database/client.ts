import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "./schema";

export function createDb(config: { url: string; authToken?: string }) {
  const clientConfig: { url: string; authToken?: string } = { url: config.url };
  if (config.authToken) {
    clientConfig.authToken = config.authToken;
  }
  const client = createClient(clientConfig);
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { eq, and, inArray };