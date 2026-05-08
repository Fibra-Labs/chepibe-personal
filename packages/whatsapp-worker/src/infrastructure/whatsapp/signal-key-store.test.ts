import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql, eq } from 'drizzle-orm';
import { whatsappSessionKeys } from '@chepibe-personal/shared';

const SESSION_ID = 'session_test';

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
};

let sqliteClient: ReturnType<typeof createClient>;
let sqliteDb: ReturnType<typeof drizzle>;

import { SqliteKeyStore } from './signal-key-store.js';

describe('SqliteKeyStore', () => {
	let store: SqliteKeyStore;

	beforeAll(async () => {
		sqliteClient = createClient({ url: ':memory:' });
		sqliteDb = drizzle(sqliteClient, { schema: { whatsappSessionKeys } });

		await sqliteClient.execute(`
			CREATE TABLE IF NOT EXISTS whatsapp_session_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				key_type TEXT NOT NULL,
				key_id TEXT NOT NULL,
				key_data TEXT,
				created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
				updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
			)
		`);
		await sqliteClient.execute(`
			CREATE UNIQUE INDEX IF NOT EXISTS uq_session_keys_type_id
			ON whatsapp_session_keys(session_id, key_type, key_id)
		`);
	});

	beforeEach(() => {
		vi.clearAllMocks();

		store = new SqliteKeyStore(
			SESSION_ID,
			sqliteDb,
			sqliteClient,
			mockLogger as any,
		);
	});

	afterEach(async () => {
		await store.destroy().catch(() => {});
		await sqliteDb.delete(whatsappSessionKeys)
			.where(eq(whatsappSessionKeys.sessionId, SESSION_ID));
	});

	describe('destroy()', () => {
		it('clears the flush interval', () => {
			expect((store as any).flushInterval).toBeDefined();

			store.destroy();

			expect((store as any).flushInterval).toBeUndefined();
		});

		it('flushes pending mutations on destroy', async () => {
			await store.set({
				'pre-key': { key1: Buffer.from('test') },
			});

			await store.destroy();

			const rows = await sqliteDb.select()
				.from(whatsappSessionKeys)
				.where(eq(whatsappSessionKeys.sessionId, SESSION_ID));

			expect(rows.length).toBeGreaterThan(0);
			expect(rows.some(r => r.keyType === 'pre-key' && r.keyId === 'key1')).toBe(true);
		});

		it('resolves even if flush has nothing to do', async () => {
			await expect(store.destroy()).resolves.toBeUndefined();
		});

		it('is safe to call destroy multiple times', async () => {
			await store.destroy();
			await expect(store.destroy()).resolves.toBeUndefined();
		});
	});

	describe('forceFlush() before destroy()', () => {
		it('forceFlush + destroy does not double-flush', async () => {
			await store.set({
				'pre-key': { key1: Buffer.from('test') },
			});

			await store.forceFlush();

			const rowsAfterFlush = await sqliteDb.select()
				.from(whatsappSessionKeys)
				.where(eq(whatsappSessionKeys.sessionId, SESSION_ID));
			const afterFlushCount = rowsAfterFlush.length;

			await store.destroy();

			const rowsAfterDestroy = await sqliteDb.select()
				.from(whatsappSessionKeys)
				.where(eq(whatsappSessionKeys.sessionId, SESSION_ID));

			expect(rowsAfterDestroy.length).toBe(afterFlushCount);
		});
	});

	describe('set() and get() round-trip', () => {
		it('stores and retrieves keys', async () => {
			await store.set({
				'pre-key': { key1: Buffer.from('hello') },
			});
			await store.forceFlush();

			const result = await store.get('pre-key', ['key1']);
			expect(result.key1).toBeDefined();
		});

		it('retrieves keys from DB after flush', async () => {
			await store.set({
				'pre-key': { key2: Buffer.from('world') },
			});
			await store.forceFlush();

			const store2 = new SqliteKeyStore(
				SESSION_ID,
				sqliteDb,
				sqliteClient,
				mockLogger as any,
			);

			await store2.loadFromDB();

			const result = await store2.get('pre-key', ['key2']);
			expect(result.key2).toBeDefined();

			await store2.destroy();
		});
	});
});
