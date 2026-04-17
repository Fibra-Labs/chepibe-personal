import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client.js";

let hasRunMigrations = false;

export async function runMigrations(db: Db, migrationsFolder = "./drizzle"): Promise<boolean> {
  if (hasRunMigrations) return true;
  hasRunMigrations = true;
  
  try {
    await migrate(db as any, { migrationsFolder });
    return true;
  } catch (err) {
    throw new Error(`Database migrations failed from "${migrationsFolder}": ${err}`);
  }
}