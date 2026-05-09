import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql, eq } from 'drizzle-orm';
import { whatsappSessionKeys, runMigrations } from '@chepibe-personal/shared';

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

import { SignalKeyStore } from './signal-key-store.js';

describe('SignalKeyStore', () => {
  let store: SignalKeyStore;

  beforeAll(async () => {
    sqliteClient = createClient({ url: ':memory:' });
    sqliteDb = drizzle(sqliteClient, { schema: { whatsappSessionKeys } });

    await sqliteClient.execute(`PRAGMA journal_mode = WAL;`);
    await runMigrations(sqliteDb as any, './drizzle');
  });

  beforeEach(() => {
    vi.clearAllMocks();

    store = new SignalKeyStore(
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
      const testKey = { public: Buffer.from('pub'), private: Buffer.from('priv') };
      await store.set({
        'pre-key': { key1: testKey },
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
      const testKey = { public: Buffer.from('pub'), private: Buffer.from('priv') };
      await store.set({
        'pre-key': { key1: testKey },
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
      const testKey = { public: Buffer.from('pub1'), private: Buffer.from('priv1') };
      await store.set({
        'pre-key': { key1: testKey },
      });
      await store.forceFlush();

      const result = await store.get('pre-key', ['key1']);
      expect(result.key1).toBeDefined();
    });

    it('retrieves keys from DB after flush', async () => {
      const testKey = { public: Buffer.from('pub2'), private: Buffer.from('priv2') };
      await store.set({
        'pre-key': { key2: testKey },
      });
      await store.forceFlush();

      const store2 = new SignalKeyStore(
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
