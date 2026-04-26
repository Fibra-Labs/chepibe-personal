import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client.js";

export async function runMigrations(db: Db, migrationsFolder = "./drizzle"): Promise<boolean> {
  try {
    // Let Drizzle handle the state internally!
    await migrate(db as any, { migrationsFolder });
    return true;
  } catch (err) {
    throw new Error(`Database migrations failed from "${migrationsFolder}": ${err}`);
  }
}
