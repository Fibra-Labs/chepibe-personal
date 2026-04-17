import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL!;
const dbPassword = process.env.DATABASE_PASSWORD || undefined;

export default defineConfig({
  dialect: "turso",
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbUrl,
    authToken: dbPassword,
  },
});
