import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const whatsappSessions = sqliteTable("whatsapp_sessions", {
  id: text("id").primaryKey(),
  phoneNumber: text("phone_number"),
  status: text("status").default("pending").notNull(),
  creds: text("creds"),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`).notNull(),
});

export type WhatsappSession = typeof whatsappSessions.$inferSelect;
export type NewWhatsappSession = typeof whatsappSessions.$inferInsert;

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

export type WhatsappSessionKey = typeof whatsappSessionKeys.$inferSelect;
export type NewWhatsappSessionKey = typeof whatsappSessionKeys.$inferInsert;