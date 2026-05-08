import { Mutex } from 'async-mutex';
import makeWASocket, {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type SignalKeyStoreWithTransaction,
  type WASocket,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import { eq, inArray, whatsappSessions, whatsappSessionKeys } from '@chepibe-personal/shared';
import { ok, err, type Result } from '../types/result';
import { SessionStateMachine } from './session-state-machine';
import type { SessionStatus } from '../types/session-status';
import { SessionEventName, type SessionEvent, type SessionEventName as TSessionEventName } from '../types/session-events';
import { BaileysDisconnectCode, TeardownReason } from '../types/disconnect-reason';
import { SqliteKeyStore } from '../infrastructure/whatsapp/signal-key-store';
import type { AudioHandler } from '../infrastructure/groq/audio-handler';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;
const QR_TIMEOUT_MS = 60000;
const PAIRING_TIMEOUT_MS = 60000;
const DEBUG = process.env.DEBUG === 'true';

export class SessionActor {
  readonly sessionId: string;
  private phoneNumber: string | null = null;
  private socket: WASocket | null = null;
  private readonly stateMachine: SessionStateMachine;
  private readonly lock: Mutex;
  private keyStore: SqliteKeyStore | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private processedMessages = new NodeCache({ stdTTL: 86400, useClones: false });
  private readonly lidToPhoneCache = new Map<string, string>();
  private abortController: AbortController | null = null;
  private lastActivityAt = new Date();

  constructor(
    sessionId: string,
    private readonly db: Db,
    private readonly client: Client,
    private readonly audioHandler: AudioHandler,
    private readonly logger: Logger,
    private readonly allowedPhone: string,
    private readonly eventSink: (event: SessionEvent) => void | Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.stateMachine = new SessionStateMachine();
    this.lock = new Mutex();
  }

  async startQR(): Promise<Result<{ qrCode: string }, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== 'none' && state !== 'destroyed') {
        return err(new Error(`Cannot startQR from state ${state}`));
      }

      const trans = this.stateMachine.transition('pending', 'startQR');
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for QR');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;

      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ qrCode: string }, Error>>((resolve) => {
          const timeout = setTimeout(() => {
            this.abortController?.abort();
            resolve(err(new Error('Timeout waiting for QR code')));
          }, QR_TIMEOUT_MS);

          socket.ev.process(async (events) => {
            if (this.abortController?.signal.aborted) return;

            if (events['connection.update']) {
              const { connection, qr } = events['connection.update'];

              if (qr) {
                clearTimeout(timeout);
                this.logger.info({ sessionId: this.sessionId }, 'QR code generated');
                await saveCredentials();
                await this.emitEvent(SessionEventName.QrReady, { sessionId: this.sessionId, qrCode: qr });
                resolve(ok({ qrCode: qr }));
                this.abortController?.abort();
              }

              if (connection === 'open') {
                clearTimeout(timeout);
                const openResult = await this.onConnectionOpen(socket, saveCredentials);
                if (!openResult.ok) {
                  resolve(openResult as Result<never, Error>);
                }
                resolve(ok({ qrCode: '' }));
                this.abortController?.abort();
              }
            }
          });
        });

        if (!result.ok) {
          await this.doTeardown(true, TeardownReason.QrTimeout);
        }
        return result;
      } finally {
        this.abortController = null;
      }
    });
  }

  async startPairing(phoneNumber: string): Promise<Result<{ code: string }, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== 'none' && state !== 'destroyed') {
        return err(new Error(`Cannot startPairing from state ${state}`));
      }

      const trans = this.stateMachine.transition('pending', 'startPairing');
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for pairing code');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;

      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ code: string }, Error>>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.abortController?.abort();
            resolve(err(new Error('Timeout waiting for pairing code')));
          }, PAIRING_TIMEOUT_MS);

          socket.ev.process(async (events) => {
            if (this.abortController?.signal.aborted) return;

            if (events['connection.update']) {
              const { connection, qr } = events['connection.update'];

              if (qr) {
                try {
                  const code = await socket.requestPairingCode(phoneNumber);
                  this.logger.info({ sessionId: this.sessionId }, 'Pairing code generated');
                  clearTimeout(timeout);
                  await saveCredentials();
                  resolve(ok({ code }));
                  this.abortController?.abort();
                } catch (err) {
                  clearTimeout(timeout);
                  resolve(err(new Error('Failed to request pairing code')));
                  this.abortController?.abort();
                }
              }

              if (connection === 'open') {
                clearTimeout(timeout);
                await this.onConnectionOpen(socket, saveCredentials);
                resolve(ok({ code: '' }));
                this.abortController?.abort();
              }
            }
          });
        });

        if (!result.ok) {
          await this.doTeardown(true, TeardownReason.PairingTimeout);
        }
        return result;
      } finally {
        this.abortController = null;
      }
    });
  }

  async reconnect(): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      const state = this.stateMachine.getState();
      if (state !== 'none' && state !== 'connected' && state !== 'reconnecting') {
        return ok(undefined);
      }

      const trans = this.stateMachine.transition('reconnecting', `reconnect attempt ${this.reconnectAttempts + 1}`);
      if (!trans.ok) return trans;

      try {
        const setup = await this.setupSocketAndSession('Reconnecting with saved credentials');
        if (!setup.ok) return setup;

        const { socket, saveCredentials } = setup.value;

        socket.ev.process(async (events) => {
          if (events['connection.update']) {
            const { connection } = events['connection.update'];
            if (connection === 'open') {
              await this.onConnectionOpen(socket, saveCredentials);
            }
          }
        });

        return ok(undefined);
      } catch (e) {
        return err(new Error('Reconnect failed', { cause: e }));
      }
    });
  }

  async stop(reason?: string): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      return this.doTeardown(false, reason ?? TeardownReason.Shutdown);
    });
  }

  async destroy(): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      return this.doTeardown(true, TeardownReason.Shutdown);
    });
  }

  async sendMessage(jid: string, content: any): Promise<Result<void, Error>> {
    return this.lock.runExclusive(async () => {
      if (!this.socket) return err(new Error('No socket'));
      try {
        await this.socket.sendMessage(jid, content);
        return ok(undefined);
      } catch (e) {
        return err(new Error('Send failed', { cause: e }));
      }
    });
  }

  private async processEvents(socket: WASocket): Promise<void> {
    await socket.ev.process(async (events) => {
      if (events['connection.update']) {
        await this.handleConnectionUpdate(events['connection.update']);
      }
      if (events['messages.upsert']) {
        for (const msg of events['messages.upsert'].messages) {
          await this.handleMessage(msg);
        }
      }
      if (events['creds.update']) {
        await this.keyStore?.set({});
      }
    });
  }

  private async handleConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;

      if (statusCode === BaileysDisconnectCode.LoggedOut) {
        await this.emitEvent(SessionEventName.PermanentDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.LoggedOut,
          statusCode,
        });
        await this.doTeardown(true, TeardownReason.LoggedOut);
        return;
      }

      if (statusCode === BaileysDisconnectCode.RestartRequired) {
        await this.emitEvent(SessionEventName.RecoverableDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.ConnectionClosed,
          statusCode,
        });
        await this.scheduleReconnect();
        return;
      }

      this.reconnectAttempts++;
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        await this.emitEvent(SessionEventName.PermanentDisconnect, {
          sessionId: this.sessionId,
          reason: TeardownReason.MaxRetries,
          statusCode: statusCode ?? 0,
        });
        await this.doTeardown(true, TeardownReason.MaxRetries);
        return;
      }

      const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
      await this.emitEvent(SessionEventName.RecoverableDisconnect, {
        sessionId: this.sessionId,
        reason: TeardownReason.ConnectionClosed,
        statusCode: statusCode ?? 0,
      });
      await this.scheduleReconnect(delay);
    }
  }

  private async scheduleReconnect(delayMs = RECONNECT_BASE_DELAY_MS): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      void this.reconnect();
    }, delayMs);
  }

  private async handleMessage(msg: any): Promise<void> {
    const state = this.stateMachine.getState();
    if (state !== 'connected') return;

    this.lastActivityAt = new Date();

    if (!msg.message) return;

    const audioMessage = msg.message.audioMessage || msg.message.pttMessage;
    if (!audioMessage) return;

    const msgId = msg.key.id;
    const dedupKey = `${this.sessionId}:${msgId}`;
    if (this.processedMessages.has(dedupKey)) return;

    const sender = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;

    if (isFromMe) {
      this.processedMessages.set(dedupKey, true);
      return;
    }

    const resolvedPhone = await this.resolvePhoneFromJid(sender, msg);
    if (resolvedPhone !== this.allowedPhone) {
      this.processedMessages.set(dedupKey, true);
      return;
    }

    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) {
        this.logger.warn({ sessionId: this.sessionId, msgId }, 'Media download returned empty');
        return;
      }
      await this.audioHandler.handleAudioMessage(
        this.phoneNumber ?? this.allowedPhone,
        { buffer, mimetype: audioMessage.mimetype, duration: audioMessage.seconds, msgId },
        this.socket!,
      );
      this.processedMessages.set(dedupKey, true);
    } catch (e) {
      this.logger.error({ err: e, sessionId: this.sessionId, msgId }, 'Failed to process audio message');
      throw e;
    }
  }

  private async resolvePhoneFromJid(jid: string, msg: any): Promise<string | null> {
    if (jid.endsWith('@s.whatsapp.net')) {
      return jid.split('@')[0];
    }
    if (jid.endsWith('@lid')) {
      const cached = this.lidToPhoneCache.get(jid);
      if (cached) return cached;
      const phone = await this.resolveLidToPhone(jid);
      if (phone) {
        this.lidToPhoneCache.set(jid, phone);
      }
      return phone;
    }
    if (msg.key.participant) {
      return this.resolvePhoneFromJid(msg.key.participant, msg);
    }
    return this.phoneNumber;
  }

  private async resolveLidToPhone(_lid: string): Promise<string | null> {
    return null;
  }

  private async setupSocketAndSession(logMessage: string): Promise<Result<{ socket: WASocket; saveCredentials: () => Promise<void> }, Error>> {
    const authState = await this.loadOrCreateAuthState();
    const version = await fetchLatestBaileysVersion();

    const keyStore = new SqliteKeyStore(this.sessionId, this.db, this.client, this.logger);
    this.keyStore = keyStore;
    await keyStore.loadFromDB();

    const socket = makeWASocket({
      version: version.version,
      logger: this.logger,
      printQRInTerminal: false,
      auth: {
        creds: authState.state.creds,
        keys: makeCacheableSignalKeyStore(keyStore, this.logger),
      },
    });

    this.socket = socket;
    return ok({ socket, saveCredentials: authState.saveCredentials });
  }

  private async loadOrCreateAuthState(): Promise<{ state: AuthenticationState; saveCredentials: () => Promise<void> }> {
    const rows = await this.db
      .select({ id: whatsappSessions.id, creds: whatsappSessions.creds })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    if (rows.length > 0 && rows[0].creds) {
      const creds: AuthenticationCreds = JSON.parse(rows[0].creds, BufferJSON.reviver);
      const state: AuthenticationState = { creds, keys: {} };
      const saveCredentials = async () => {
        await this.db
          .insert(whatsappSessions)
          .values({ id: this.sessionId, status: 'pending', creds: JSON.stringify(creds, BufferJSON.replacer) })
          .onConflictDoUpdate({
            target: whatsappSessions.id,
            set: { creds: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() },
          });
      };
      return { state, saveCredentials };
    }

    const creds = initAuthCreds();
    const state: AuthenticationState = { creds, keys: {} };
    const saveCredentials = async () => {
      await this.db
        .insert(whatsappSessions)
        .values({ id: this.sessionId, status: 'pending', creds: JSON.stringify(creds, BufferJSON.replacer) })
        .onConflictDoUpdate({
          target: whatsappSessions.id,
          set: { creds: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() },
        });
    };
    return { state, saveCredentials };
  }

  private async onConnectionOpen(socket: WASocket, saveCredentials: () => Promise<void>): Promise<Result<void, Error>> {
    await saveCredentials();

    const phoneFromSocket = socket.user?.id?.split(':')[0].replace(/\D/g, '');
    if (phoneFromSocket && phoneFromSocket !== this.allowedPhone) {
      this.logger.fatal({ sessionId: this.sessionId, connectedPhone: phoneFromSocket, allowedPhone: this.allowedPhone }, 'Phone number mismatch');
      await this.emitEvent(SessionEventName.PermanentDisconnect, {
        sessionId: this.sessionId,
        reason: TeardownReason.PhoneMismatch,
        statusCode: 401,
      });
      await this.doTeardown(true, TeardownReason.PhoneMismatch);
      return err(new Error('Phone number mismatch'));
    }

    this.phoneNumber = phoneFromSocket ?? this.allowedPhone;
    const trans = this.stateMachine.transition('connected', 'connection.open');
    if (!trans.ok) return trans;

    await saveCredentials();

    await this.emitEvent(SessionEventName.Connected, {
      sessionId: this.sessionId,
      phoneNumber: this.phoneNumber,
    });

    void this.processEvents(socket);

    return ok(undefined);
  }

  private async doTeardown(deleteData: boolean, reason: string): Promise<Result<void, Error>> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.socket) {
      try {
        await this.socket.end({ logOut: deleteData });
      } catch {
      }
      this.socket = null;
    }

    if (this.keyStore) {
      await this.keyStore.forceFlush();
      this.keyStore.destroy?.();
      this.keyStore = null;
    }

    if (deleteData) {
      await this.db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, this.sessionId));
      await this.db.delete(whatsappSessions).where(eq(whatsappSessions.id, this.sessionId));
    } else {
      await this.db
        .update(whatsappSessions)
        .set({ status: 'disconnected' as any })
        .where(eq(whatsappSessions.id, this.sessionId));
    }

    this.processedMessages.flushAll();
    this.lidToPhoneCache.clear();

    const trans = this.stateMachine.transition('destroyed', reason);
    if (!trans.ok) return trans;

    await this.emitEvent(SessionEventName.Disconnected, { sessionId: this.sessionId, reason });

    return ok(undefined);
  }

  private async emitEvent(type: TSessionEventName, payload: any): Promise<void> {
    const event: SessionEvent = { type, payload } as SessionEvent;
    try {
      await this.eventSink(event);
    } catch (e) {
      this.logger.error({ err: e, sessionId: this.sessionId, eventType: type }, 'EventSink error');
    }
  }

  getStatus(): SessionStatus {
    return this.stateMachine.getState();
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  isResponsive(): boolean {
    const diff = Date.now() - this.lastActivityAt.getTime();
    return diff < 60000;
  }
}
