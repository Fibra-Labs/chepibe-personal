import { Mutex } from 'async-mutex';
import makeWASocket, {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import type { Db } from '@chepibe-personal/shared';
import { eq, whatsappSessions, whatsappSessionKeys } from '@chepibe-personal/shared';
import { sql } from 'drizzle-orm';
import { ok, err, type Result } from '../types/result';
import { SessionStateMachine } from './session-state-machine';
import type { SessionStatus } from '../types/session-status';
import { SessionEventName, type SessionEvent, type SessionEventName as TSessionEventName } from '../types/session-events';
import { BaileysDisconnectCode, TeardownReason } from '../types/disconnect-reason';
import { SqliteKeyStore } from '../infrastructure/whatsapp/signal-key-store';
import type { AudioHandler } from '../infrastructure/groq/audio-handler';
import {
  SessionState,
  BaileysEvent,
  BaileysConnection,
  SessionAction,
  DB_SESSION_STATUS_PENDING,
  DB_SESSION_STATUS_CONNECTED,
  DB_SESSION_STATUS_DISCONNECTED,
  WHATSAPP_JID_SUFFIX,
  LID_SUFFIX,
  DEDUP_TTL_SECONDS,
  RESPONSIVE_THRESHOLD_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  QR_TIMEOUT_MS,
  PAIRING_TIMEOUT_MS,
  ERROR_PREFIX_TIMEOUT_QR,
  ERROR_PREFIX_TIMEOUT_PAIRING,
  ERROR_PAIRING_CODE_FAILED,
  ERROR_PHONE_MISMATCH,
  ERROR_NO_SOCKET,
  ERROR_SEND_FAILED,
  ERROR_RECONNECT_FAILED,
} from '../constants/session.constants';

export class SessionActor {
  readonly sessionId: string;
  private phoneNumber: string | null = null;
  private socket: WASocket | null = null;
  private readonly stateMachine: SessionStateMachine;
  private readonly lock: Mutex;
  private keyStore: SqliteKeyStore | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private processedMessages = new NodeCache({ stdTTL: DEDUP_TTL_SECONDS, useClones: false });
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
      if (state !== SessionState.None && state !== SessionState.Destroyed) {
        return err(new Error(`Cannot startQR from state ${state}`));
      }

      const trans = this.stateMachine.transition(SessionState.Pending, SessionAction.StartQr);
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for QR');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;

      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ qrCode: string }, Error>>((resolve) => {
          const timeout = setTimeout(() => {
            socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
            this.abortController?.abort();
            resolve(err(new Error(ERROR_PREFIX_TIMEOUT_QR)));
          }, QR_TIMEOUT_MS);

          const updateListener = async (update: any) => {
            const { connection, qr } = update;

            if (this.abortController?.signal.aborted) return;

            if (qr) {
              clearTimeout(timeout);
              socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
              this.logger.info({ sessionId: this.sessionId }, 'QR code generated');
              await saveCredentials();
              await this.emitEvent(SessionEventName.QrReady, { sessionId: this.sessionId, qrCode: qr });
              resolve(ok({ qrCode: qr }));
              return;
            }

            if (connection === BaileysConnection.Open) {
              clearTimeout(timeout);
              socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(ok({ qrCode: '' }));
              return;
            }

            if (connection === BaileysConnection.Close) {
              clearTimeout(timeout);
              socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(err(new Error('Connection closed during QR')));
            }
          };

          socket.ev.on(BaileysEvent.ConnectionUpdate, updateListener);
        });

        if (!result.ok) {
          const reason = result.error.message.includes('closed')
            ? TeardownReason.ConnectionClosed
            : TeardownReason.QrTimeout;
          await this.doTeardown(true, reason);
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
      if (state !== SessionState.None && state !== SessionState.Destroyed) {
        return err(new Error(`Cannot startPairing from state ${state}`));
      }

      const trans = this.stateMachine.transition(SessionState.Pending, SessionAction.StartPairing);
      if (!trans.ok) return trans as Result<never, Error>;

      const setup = await this.setupSocketAndSession('Creating Baileys socket for pairing code');
      if (!setup.ok) return setup;

      const { socket, saveCredentials } = setup.value;

      this.abortController = new AbortController();

      try {
        const result = await new Promise<Result<{ code: string }, Error>>((resolve) => {
          const timeout = setTimeout(() => {
            socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
            this.abortController?.abort();
            resolve(err(new Error(ERROR_PREFIX_TIMEOUT_PAIRING)));
          }, PAIRING_TIMEOUT_MS);

          const updateListener = async (update: any) => {
            const { connection, qr } = update;

            if (this.abortController?.signal.aborted) return;

            if (qr) {
              try {
                const code = await socket.requestPairingCode(phoneNumber);
                this.logger.info({ sessionId: this.sessionId }, 'Pairing code generated');
                clearTimeout(timeout);
                socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
                await saveCredentials();
                resolve(ok({ code }));
                return;
              } catch (pairingErr) {
                clearTimeout(timeout);
                socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
                resolve(err(new Error(ERROR_PAIRING_CODE_FAILED)));
                this.abortController?.abort();
                return;
              }
            }

            if (connection === BaileysConnection.Open) {
              clearTimeout(timeout);
              socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(ok({ code: '' }));
              return;
            }

            if (connection === BaileysConnection.Close) {
              clearTimeout(timeout);
              socket.ev.off(BaileysEvent.ConnectionUpdate, updateListener);
              this.abortController?.abort();
              resolve(err(new Error('Connection closed during pairing')));
            }
          };

          socket.ev.on(BaileysEvent.ConnectionUpdate, updateListener);
        });

        if (!result.ok) {
          const reason = result.error.message.includes('closed')
            ? TeardownReason.ConnectionClosed
            : result.error.message.includes('pairing')
              ? TeardownReason.PairingCodeFailed
              : TeardownReason.PairingTimeout;
          await this.doTeardown(true, reason);
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
      if (state !== SessionState.None && state !== SessionState.Pending && state !== SessionState.Connected && state !== SessionState.Reconnecting) {
        this.logger.warn({ state, sessionId: this.sessionId }, 'reconnect() skipped: invalid state');
        return ok(undefined);
      }

      if (state === SessionState.None) {
        const pendingTrans = this.stateMachine.transition(SessionState.Pending, 'reconnect-init');
        if (!pendingTrans.ok) {
          this.logger.error({ state: this.stateMachine.getState(), err: pendingTrans.error, sessionId: this.sessionId }, 'reconnect() failed None→Pending transition');
          return pendingTrans;
        }
      }

      const trans = this.stateMachine.transition(SessionState.Reconnecting, `reconnect attempt ${this.reconnectAttempts + 1}`);
      if (!trans.ok) {
        this.logger.error({ state: this.stateMachine.getState(), err: trans.error, sessionId: this.sessionId }, 'reconnect() failed state transition');
        return trans;
      }

      if (this.socket) {
        try {
          await this.socket.end(undefined);
        } catch { /* best-effort */
        }
        this.socket = null;
      }

      if (this.keyStore) {
        try {
          await this.keyStore.forceFlush();
        } catch { /* best-effort */
        }
        this.keyStore = null;
      }

      try {
        const setup = await this.setupSocketAndSession('Reconnecting with saved credentials');
        if (!setup.ok) return setup;

        return ok(undefined);
      } catch (e) {
        return err(new Error(ERROR_RECONNECT_FAILED, { cause: e }));
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
      if (!this.socket) return err(new Error(ERROR_NO_SOCKET));
      try {
        await this.socket.sendMessage(jid, content);
        return ok(undefined);
      } catch (e) {
        return err(new Error(ERROR_SEND_FAILED, { cause: e }));
      }
    });
  }

  private setupMessageListener(socket: WASocket): void {
    socket.ev.on(BaileysEvent.MessagesUpsert, async (m: any) => {
      this.logger.info({ sessionId: this.sessionId, type: m.type, messageCount: m.messages?.length }, 'Received messages');
      if (m.messages) {
        for (const msg of m.messages) {
          await this.handleMessage(msg);
        }
      }
    });
  }

  private async handleConnectionUpdate(update: any, socket?: WASocket, saveCredentials?: () => Promise<void>): Promise<void> {
    const { connection, lastDisconnect, isNewLogin } = update;

    // Guard against duplicate reconnect scheduling when already handling a reconnect event
    if (this.stateMachine.getState() === SessionState.Reconnecting && this.reconnectTimeout) {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
      const isDuplicateReconnectTrigger = isNewLogin || statusCode === BaileysDisconnectCode.RestartRequired;
      if (isDuplicateReconnectTrigger) {
        this.logger.warn({ sessionId: this.sessionId, isNewLogin, statusCode }, 'Ignoring duplicate reconnect trigger while already reconnecting');
        return;
      }
    }

    if (isNewLogin) {
      this.reconnectAttempts = 0;
      const trans = this.stateMachine.transition(SessionState.Reconnecting, 'isNewLogin');
      if (trans.ok) {
        await this.scheduleReconnect();
      }
      return;
    }

    if (connection === BaileysConnection.Open) {
      this.reconnectAttempts = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (socket && saveCredentials) {
        await this.onConnectionOpen(socket, saveCredentials);
      }
    }

    if (connection === BaileysConnection.Close) {
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
        this.reconnectAttempts = 0;
        const trans = this.stateMachine.transition(SessionState.Reconnecting, '515-restart-required');
        if (!trans.ok) {
          this.logger.error({ state: this.stateMachine.getState(), err: trans.error, sessionId: this.sessionId }, 'Failed 515 transition to Reconnecting, falling back to teardown');
          await this.doTeardown(true, TeardownReason.ConnectionClosed);
          return;
        }
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
    if (state !== SessionState.Connected) {
      this.logger.debug({ sessionId: this.sessionId, state }, 'Ignoring message: not connected');
      return;
    }

    this.lastActivityAt = new Date();

    if (!msg.message) {
      this.logger.debug({ sessionId: this.sessionId }, 'Ignoring message: no message content');
      return;
    }

    const audioMessage = msg.message.audioMessage || msg.message.pttMessage;
    if (!audioMessage) {
      this.logger.debug({ sessionId: this.sessionId, messageType: Object.keys(msg.message)[0] }, 'Ignoring message: not audio');
      return;
    }

    this.logger.info({ sessionId: this.sessionId, sender: msg.key.remoteJid, fromMe: msg.key.fromMe }, 'Processing audio message');

    const msgId = msg.key.id;
    const dedupKey = `${this.sessionId}:${msgId}`;
    if (this.processedMessages.has(dedupKey)) return;

    const sender = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;

    // Skip messages we sent (but allow voice messages we send to ourselves)
    // Voice messages to self have fromMe=true but are the ones we want to process
    if (isFromMe && sender !== this.phoneNumber && !sender.endsWith('@lid')) {
      this.logger.debug({ sessionId: this.sessionId, msgId, sender }, 'Ignoring message: sent by us to someone else');
      this.processedMessages.set(dedupKey, true);
      return;
    }

    // Process audio messages
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) {
        this.logger.warn({ sessionId: this.sessionId, msgId }, 'Media download returned empty');
        return;
      }

      // Resolve sender's phone number and get pushName (display name)
      const resolvedSenderPhone = await this.resolvePhoneFromJid(sender, msg);
      const pushName = msg.pushName || null;

      await this.audioHandler.handleAudioMessage(
        this.socket!,
        sender,
        buffer,
        audioMessage.mimetype,
        msgId,
        audioMessage.seconds,
        this.phoneNumber ?? this.allowedPhone,
        resolvedSenderPhone,
        pushName,
      );
      this.processedMessages.set(dedupKey, true);
    } catch (e) {
      this.logger.error({ err: e, sessionId: this.sessionId, msgId }, 'Failed to process audio message');
    }
  }

  private async resolvePhoneFromJid(jid: string, msg: any): Promise<string | null> {
    if (jid.endsWith(WHATSAPP_JID_SUFFIX)) {
      return jid.split('@')[0];
    }
    if (jid.endsWith(LID_SUFFIX)) {
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
    const { creds, saveCredentials } = await this.loadOrCreateAuthState();
    const version = await fetchLatestBaileysVersion();

    const keyStore = new SqliteKeyStore(this.sessionId, this.db, this.client, this.logger);
    this.keyStore = keyStore;
    await keyStore.loadFromDB();

    const keys = makeCacheableSignalKeyStore(keyStore, this.logger);
    const authState: AuthenticationState = { creds, keys };

    // Use silent logger for Baileys to prevent leaking message content in logs
    const socket = makeWASocket({
      version: version.version,
      logger: this.logger.child({ baileys: true, level: 'silent' }),
      printQRInTerminal: false,
      auth: authState,
    });

    socket.ev.on(BaileysEvent.CredsUpdate, () => { void saveCredentials(); });

    socket.ev.on(BaileysEvent.ConnectionUpdate, (update) => {
      this.handleConnectionUpdate(update, socket, saveCredentials).catch((e) =>
        this.logger.error({ err: e, sessionId: this.sessionId }, 'Error in global connection update handler'),
      );
    });

    this.socket = socket;
    return ok({ socket, saveCredentials });
  }

  private async loadOrCreateAuthState(): Promise<{ creds: AuthenticationCreds; saveCredentials: () => Promise<void> }> {
    const rows = await this.db
      .select({ id: whatsappSessions.id, creds: whatsappSessions.creds })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    const creds: AuthenticationCreds = rows.length > 0 && rows[0].creds
      ? JSON.parse(rows[0].creds, BufferJSON.reviver)
      : initAuthCreds();

    const saveCredentials = async () => {
      await this.db
        .insert(whatsappSessions)
        .values({ id: this.sessionId, status: DB_SESSION_STATUS_PENDING, creds: JSON.stringify(creds, BufferJSON.replacer) })
        .onConflictDoUpdate({
          target: whatsappSessions.id,
          set: { creds: JSON.stringify(creds, BufferJSON.replacer), updatedAt: sql`(unixepoch())` },
        });
    };

    return { creds, saveCredentials };
  }

  private async onConnectionOpen(socket: WASocket, saveCredentials: () => Promise<void>): Promise<Result<void, Error>> {
    await saveCredentials();

    const phoneFromSocket = socket.user?.id?.split(':')[0].replace(/\D/g, '');
    if (phoneFromSocket && phoneFromSocket !== this.allowedPhone) {
      this.logger.fatal({ sessionId: this.sessionId, connectedPhone: phoneFromSocket, allowedPhone: this.allowedPhone }, ERROR_PHONE_MISMATCH);
      await this.emitEvent(SessionEventName.PermanentDisconnect, {
        sessionId: this.sessionId,
        reason: TeardownReason.PhoneMismatch,
        statusCode: BaileysDisconnectCode.LoggedOut,
      });
      await this.doTeardown(true, TeardownReason.PhoneMismatch);
      return err(new Error(ERROR_PHONE_MISMATCH));
    }

    this.phoneNumber = phoneFromSocket ?? this.allowedPhone;
    const trans = this.stateMachine.transition(SessionState.Connected, SessionAction.ConnectionOpen);
    if (!trans.ok) return trans;

    await saveCredentials();

    await this.db
      .update(whatsappSessions)
      .set({ status: DB_SESSION_STATUS_CONNECTED, phoneNumber: this.phoneNumber, updatedAt: sql`(unixepoch())` })
      .where(eq(whatsappSessions.id, this.sessionId));

    await this.emitEvent(SessionEventName.Connected, {
      sessionId: this.sessionId,
      phoneNumber: this.phoneNumber,
    });

    this.setupMessageListener(socket);

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
        await this.socket.end(undefined);
      } catch { /* best-effort teardown */
      }
      this.socket = null;
    }

    if (this.keyStore) {
      await this.keyStore.forceFlush();
      this.keyStore.destroy?.();
      this.keyStore = null;
    }

    if (deleteData) {
      console.log('delete data');
      await this.db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, this.sessionId));
      await this.db.delete(whatsappSessions).where(eq(whatsappSessions.id, this.sessionId));
    } else {
      await this.db
        .update(whatsappSessions)
        .set({ status: DB_SESSION_STATUS_DISCONNECTED })
        .where(eq(whatsappSessions.id, this.sessionId));
    }

    this.processedMessages.flushAll();
    this.lidToPhoneCache.clear();

    const transitionResult = this.stateMachine.transition(SessionState.Destroyed, reason);
    if (!transitionResult.ok) return transitionResult;

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
    return diff < RESPONSIVE_THRESHOLD_MS;
  }
}
