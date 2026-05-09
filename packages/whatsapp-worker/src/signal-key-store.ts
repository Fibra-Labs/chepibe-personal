import { BufferJSON, type SignalDataSet, type SignalDataTypeMap, type SignalKeyStore } from '@whiskeysockets/baileys';
import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import { whatsappSessionKeys, eq, and, inArray } from '@chepibe-personal/shared';
import { sql } from 'drizzle-orm';

const UPSERT = 'upsert' as const;
const DELETE = 'delete' as const;
type MutationOperation = typeof UPSERT | typeof DELETE;

interface KeyMutation {
  type: string;
  id: string;
  value: unknown;
  operation: MutationOperation;
}

function isDbMovedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return e.code === 'SQLITE_READONLY_DBMOVED' || e.rawCode === 1032 ||
    (typeof e.message === 'string' && e.message.includes('readonly database'));
}

const MAX_FLUSH_RETRIES = 3;
const FLUSH_INTERVAL_MS = 2000;
const MAX_QUEUE_SIZE = 1000;

export class SignalKeyStore implements SignalKeyStore {
  private cache = new Map<string, unknown>();
  private mutationQueue: KeyMutation[] = [];
  private flushInterval?: NodeJS.Timeout;
  private flushInProgress?: Promise<void>;
  private consecutiveDbMovedErrors = 0;

  constructor(
    private sessionId: string,
    private db: Db,
    private client: Client,
    private logger: Logger,
  ) {
    this.flushInterval = setInterval(() => {
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
  }

  async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    const result: { [id: string]: SignalDataTypeMap[T] } = {};
    const missingIds: string[] = [];

    for (const id of ids) {
      const cacheKey = `${type}:${id}`;
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        result[id] = cached as SignalDataTypeMap[T];
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      try {
        const rows = await this.db.select({
          keyType: whatsappSessionKeys.keyType,
          keyId: whatsappSessionKeys.keyId,
          keyData: whatsappSessionKeys.keyData,
        })
          .from(whatsappSessionKeys)
          .where(
            and(
              eq(whatsappSessionKeys.sessionId, this.sessionId),
              eq(whatsappSessionKeys.keyType, type as string),
              inArray(whatsappSessionKeys.keyId, missingIds),
            ),
          );

        for (const row of rows) {
          const cacheKey = `${row.keyType}:${row.keyId}`;
          const revivedData = row.keyData
            ? JSON.parse(row.keyData, BufferJSON.reviver)
            : null;
          this.cache.set(cacheKey, revivedData);
          result[row.keyId] = revivedData as SignalDataTypeMap[T];
        }
      } catch (error) {
        this.logger.error({ err: error, sessionId: this.sessionId }, 'Failed to fetch keys from database');
      }
    }

    return result;
  }

  async set(data: SignalDataSet): Promise<void> {
    for (const [type, values] of Object.entries(data)) {
      for (const [id, value] of Object.entries(values || {})) {
        const cacheKey = `${type}:${id}`;
        if (value !== null) {
          this.cache.set(cacheKey, value);
          this.mutationQueue.push({ type, id, value, operation: UPSERT });
        } else {
          this.cache.delete(cacheKey);
          this.mutationQueue.push({ type, id, value: null, operation: DELETE });
        }
      }
    }

    if (this.mutationQueue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn(
        { sessionId: this.sessionId, queueSize: this.mutationQueue.length },
        'Queue size limit reached, forcing flush',
      );
      this.scheduleFlush();
    }
  }

  async loadFromDB(): Promise<void> {
    try {
      const rows = await this.db.select({
        keyType: whatsappSessionKeys.keyType,
        keyId: whatsappSessionKeys.keyId,
        keyData: whatsappSessionKeys.keyData,
      })
        .from(whatsappSessionKeys)
        .where(eq(whatsappSessionKeys.sessionId, this.sessionId));

      for (const row of rows) {
        const cacheKey = `${row.keyType}:${row.keyId}`;
        const revivedData = row.keyData
          ? JSON.parse(row.keyData, BufferJSON.reviver)
          : null;
        this.cache.set(cacheKey, revivedData);
      }

      this.logger.info({ sessionId: this.sessionId, keyCount: rows.length }, 'Loaded signal keys from DB');
    } catch (err) {
      this.logger.warn({ err, sessionId: this.sessionId }, 'Failed to load signal keys from DB, starting fresh');
    }
  }

  async forceFlush(): Promise<void> {
    if (this.flushInProgress) {
      await this.flushInProgress;
    }
    await this.doFlush();
  }

  async destroy(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = undefined;
    }
    await this.doFlush();
  }

  private scheduleFlush(): void {
    this.maybeFlush().catch((err) => {
      this.logger.error({ err, sessionId: this.sessionId }, 'Scheduled flush failed');
    });
  }

  private async maybeFlush(): Promise<void> {
    if (this.flushInProgress) {
      await this.flushInProgress;
      return;
    }

    if (this.mutationQueue.length === 0) {
      return;
    }

    this.flushInProgress = this.doFlush();
    try {
      await this.flushInProgress;
    } finally {
      this.flushInProgress = undefined;
    }
  }

  private async doFlush(): Promise<void> {
    if (this.mutationQueue.length === 0) {
      return;
    }

    const batch = [...this.mutationQueue];
    this.mutationQueue = [];

    try {
      await this.writeBatchToDb(batch);

      this.consecutiveDbMovedErrors = 0;
      this.logger.debug(
        { sessionId: this.sessionId, count: batch.length },
        'Flushed key mutations',
      );
    } catch (error) {
      this.requeueAfterFailure(batch);

      if (isDbMovedError(error)) {
        this.consecutiveDbMovedErrors++;
        this.logger.error(
          { err: error, sessionId: this.sessionId, queueSize: this.mutationQueue.length, attempt: this.consecutiveDbMovedErrors },
          'Flush failed — database file was moved/replaced (SQLITE_READONLY_DBMOVED)',
        );

        if (this.consecutiveDbMovedErrors <= MAX_FLUSH_RETRIES) {
          try {
            this.logger.info({ sessionId: this.sessionId, attempt: this.consecutiveDbMovedErrors }, 'Reopening database connection');
            this.client.execute('PRAGMA journal_mode=DELETE');
          } catch {
            this.logger.error({ sessionId: this.sessionId }, 'Failed to reopen database connection');
          }
        }

        if (this.consecutiveDbMovedErrors > MAX_FLUSH_RETRIES) {
          this.logger.fatal(
            { sessionId: this.sessionId, queueSize: this.mutationQueue.length },
            'Exceeded max DBMOVED retries — discarding queued mutations to prevent crash loop',
          );
          this.mutationQueue = [];
          this.consecutiveDbMovedErrors = 0;
        }
      } else {
        this.logger.error(
          { err: error, sessionId: this.sessionId, queueSize: this.mutationQueue.length },
          'Flush failed, will retry',
        );
      }
    }
  }

  private async writeBatchToDb(batch: KeyMutation[]): Promise<void> {
    const upserts = batch.filter(m => m.operation === UPSERT);
    const deletes = batch.filter(m => m.operation === DELETE);

    if (upserts.length > 0) {
      const now = Math.floor(Date.now() / 1000);
      await this.db.insert(whatsappSessionKeys)
        .values(
          upserts.map(m => ({
            sessionId: this.sessionId,
            keyType: m.type,
            keyId: m.id,
            keyData: JSON.stringify(m.value, BufferJSON.replacer),
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [whatsappSessionKeys.sessionId, whatsappSessionKeys.keyType, whatsappSessionKeys.keyId],
          set: {
            keyData: sql`excluded.key_data`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    if (deletes.length > 0) {
      const deletesByType = new Map<string, string[]>();
      for (const m of deletes) {
        const ids = deletesByType.get(m.type) ?? [];
        ids.push(m.id);
        deletesByType.set(m.type, ids);
      }

      for (const [type, ids] of deletesByType) {
        await this.db.delete(whatsappSessionKeys)
          .where(
            and(
              eq(whatsappSessionKeys.sessionId, this.sessionId),
              eq(whatsappSessionKeys.keyType, type),
              inArray(whatsappSessionKeys.keyId, ids),
            ),
          );
      }
    }
  }

  private requeueAfterFailure(batch: KeyMutation[]): void {
    const existingKeys = new Set(this.mutationQueue.map(m => `${m.type}:${m.id}`));
    const toRequeue = batch.filter(m => !existingKeys.has(`${m.type}:${m.id}`));
    this.mutationQueue = [...toRequeue, ...this.mutationQueue];
  }
}
